package com.bilanciomoney.bilancio

import com.clerk.api.Clerk
import com.clerk.api.network.serialization.successOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.LocalDate
import java.time.YearMonth

/**
 * The one client for the Bilancio API.
 *
 * The contract is docs/ios-app-api.md and it is the same one the iPhone app
 * follows: every amount is an integer of cents, positive is money in, and the
 * session is proved on every request rather than trusted from the client.
 *
 * Deliberately plain: HttpURLConnection and org.json, both in the platform. The
 * responses this app reads are shallow, and more dependencies on the critical
 * path of somebody's bank data is a worse trade than a little parsing by hand.
 * See SECURITY.md on keeping the dependency surface small.
 */
object Bilancio {
    const val BASE_URL = "https://bilanciomoney.com"
    const val CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuYmlsYW5jaW9tb25leS5jb20k"

    /** Sent so the server knows which store may sell a subscription here. */
    private const val CLIENT_HEADER = "android"

    class ApiError(val status: Int, message: String) : Exception(message)

    private suspend fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        /* Asked for on every call rather than held: Clerk refreshes the session
           token about once a minute, and a cached one is a 401 waiting to
           happen. successOrNull because a failure here means the session is
           gone, which is the same thing as being signed out. */
        val token = Clerk.auth.getToken().successOrNull()
            ?: throw ApiError(401, "Not signed in.")

        val connection = (URL(BASE_URL + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("X-Bilancio-Client", CLIENT_HEADER)
            setRequestProperty("Accept", "application/json")
            connectTimeout = 20_000
            readTimeout = 60_000
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        if (body != null) {
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
        }

        val status = connection.responseCode
        val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
        connection.disconnect()

        val json = if (text.isBlank()) JSONObject() else runCatching { JSONObject(text) }
            .getOrElse { throw ApiError(status, "The server sent something unreadable.") }

        if (status !in 200..299) {
            /* The Worker explains itself in `reason`, then `message`, then the
               bare `error` slug -- a 402 says why access ended, a 400 says what
               was wrong with the request. */
            val why = json.optString("reason").ifBlank {
                json.optString("message").ifBlank { json.optString("error") }
            }
            throw ApiError(status, why.ifBlank { "The server returned $status." })
        }
        json
    }

    private fun q(s: String) = URLEncoder.encode(s, "UTF-8")

    suspend fun summary(range: String): Summary =
        Summary.from(request("GET", "/api/summary?range=${q(range)}"))

    suspend fun transactions(
        range: String,
        bucket: String? = null,
        offset: Int = 0,
        limit: Int = 50,
        merchant: String? = null,
    ): TransactionPage {
        /* merchant matches the name as the reader sees it: the merchant name
           where Plaid has one, the bank's own description otherwise. */
        val filter = (if (bucket != null) "&bucket=${q(bucket)}" else "") +
            (if (!merchant.isNullOrBlank()) "&merchant=${q(merchant.trim())}" else "")
        return TransactionPage.from(
            request("GET", "/api/transactions?range=${q(range)}$filter&limit=$limit&offset=$offset"),
        )
    }

    suspend fun banks(): Banks = Banks.from(request("GET", "/api/plaid/items"))

    suspend fun trend(months: Int): Trend = Trend.from(request("GET", "/api/trend?months=$months"))

    suspend fun budget(): Budget = Budget.from(request("GET", "/api/budget"))

    /** One month set by hand, or put back to what history says (null). */
    suspend fun pinMonth(slug: String, month: String, cents: Long?) {
        request("PUT", "/api/budget", JSONObject().put("slug", slug).put("month", month)
            .put("amount", cents ?: JSONObject.NULL))
    }

    /** Every month at one figure, or back to what history says (null). */
    suspend fun setBaseline(slug: String, cents: Long?) {
        request("PUT", "/api/budget", JSONObject().put("slug", slug).put("baseline", cents ?: JSONObject.NULL))
    }

    /** Parents and their children, for screens whose own response carries only
        the leaves. */
    suspend fun categories(): List<Category> = Category.list(request("GET", "/api/categories").optJSONArray("categories"))

    suspend fun forecast(): Forecast = Forecast.from(request("GET", "/api/forecast"))

    suspend fun netWorth(months: Int): NetWorth = NetWorth.from(request("GET", "/api/assets?months=$months"))

    suspend fun rules(): List<Rule> = request("GET", "/api/rules").optJSONArray("rules").orEmpty().map(Rule::from)

    suspend fun deleteRule(id: String) {
        request("DELETE", "/api/rules/${q(id)}")
    }

    /** A new subcategory under a parent. */
    suspend fun createCategory(label: String, parentSlug: String) {
        request("POST", "/api/categories", JSONObject().put("label", label).put("parent", parentSlug))
    }

    /** Refused with a reason while anything is still filed under it. */
    suspend fun deleteCategory(id: String) {
        request("DELETE", "/api/categories/${q(id)}")
    }

    /** This transaction, and with applyToMerchant every one from its merchant
        from now on (a merchant rule). */
    suspend fun recategorise(transactionId: String, categoryId: String, applyToMerchant: Boolean) {
        request(
            "POST", "/api/transactions/${q(transactionId)}/category",
            JSONObject().put("categoryId", categoryId).put("applyToMerchant", applyToMerchant),
        )
    }

    /** A link token that repairs an existing connection rather than making one. */
    suspend fun repairToken(itemId: String): String =
        request("POST", "/api/plaid/link-token/update", JSONObject().put("itemId", itemId).put("platform", "android"))
            .getString("linkToken")

    suspend fun calendar(month: YearMonth): CalendarMonth =
        CalendarMonth.from(request("GET", "/api/calendar?month=$month"))

    suspend fun linkToken(): String =
        request("POST", "/api/plaid/link-token", JSONObject().put("platform", "android"))
            .getString("linkToken")

    suspend fun exchange(publicToken: String) {
        request("POST", "/api/plaid/exchange", JSONObject().put("publicToken", publicToken))
    }

    /** Syncs to the end. The server writes a bounded number of rows per call and
        says whether more is waiting, so a two-year backfill takes several; the
        cap is a backstop in case it somehow never says it is done. */
    suspend fun syncAll(onProgress: (Int) -> Unit = {}): SyncResult {
        var added = 0
        var last: SyncResult
        var rounds = 0
        do {
            last = SyncResult.from(request("POST", "/api/plaid/sync"))
            added += last.added
            onProgress(added)
            rounds++
        } while (last.more && rounds < 40)
        return last.copy(added = added)
    }

    suspend fun disconnect(itemId: String) {
        request("DELETE", "/api/plaid/items/${q(itemId)}")
    }

    suspend fun billing(): Billing = Billing.from(request("GET", "/api/billing/status"))

    /** True when an App Store subscription is still live and must be cancelled
        with Apple -- which cannot happen from here or from the server. */
    suspend fun deleteAccount(): Boolean =
        request("DELETE", "/api/account").optBoolean("appleStillActive", false)
}

/* ------------------------------------------------------------ date ranges -- */

/**
 * The range keys the server understands, for a month and a trailing count.
 * A single month asks for one month rather than a one-month span, because the
 * named forms know whether the month is still running (see spanRange in the
 * web app, which learned this the hard way).
 */
object Ranges {
    fun key(month: YearMonth, trailing: Int): String {
        if (trailing <= 1) {
            return if (month == YearMonth.now()) "this-month" else "month:$month"
        }
        return "span:${month.minusMonths((trailing - 1).toLong())}..$month"
    }

    /** The last twelve months, newest first. */
    fun recent(): List<YearMonth> = (0 until 12).map { YearMonth.now().minusMonths(it.toLong()) }

    fun label(m: YearMonth): String =
        m.month.name.lowercase().replaceFirstChar { it.uppercase() } + " " + m.year
}

/* ------------------------------------------------------------------ shapes -- */

data class Category(
    val id: String,
    val slug: String,
    val label: String,
    val colour: Long,
    val parentSlug: String?,
    val kind: String,
) {
    companion object {
        fun from(o: JSONObject) = Category(
            id = o.optString("id"),
            slug = o.optString("slug"),
            label = o.optString("label"),
            colour = parseColour(o.optString("colour")),
            parentSlug = if (o.isNull("parentSlug")) null else o.optString("parentSlug").ifBlank { null },
            kind = o.optString("kind", "spend"),
        )

        fun list(a: JSONArray?) = a.orEmpty().map(::from)

        private fun parseColour(hex: String): Long =
            runCatching { 0xFF000000 or hex.removePrefix("#").toLong(16) }.getOrDefault(0xFF888888)
    }
}

data class Summary(
    val label: String,
    /** YYYY-MM-DD; a period whose end is before today is complete. */
    val rangeEnd: String,
    val income: Long,
    val expense: Long,
    val net: Long,
    val accountsCounted: Int,
    val budgetIncome: Long?,
    val budgetExpense: Long?,
    val budgetNet: Long?,
    val perDay: Long?,
    val daysLeft: Int?,
    /** Spending by parent category, and what each was planned at. */
    val byParent: Map<String, Long>,
    val budgetByParent: Map<String, Long>,
    /** The same, by subcategory, for a category opened on the Overview. */
    val byCategory: Map<String, Long>,
    val budgetByCategory: Map<String, Long>,
    val previousExpense: Long?,
    val comparison: String,
    val categories: List<Category>,
) {
    companion object {
        fun from(o: JSONObject): Summary {
            val totals = o.optJSONObject("totals") ?: JSONObject()
            val budget = o.optJSONObject("budget")
            val safe = o.optJSONObject("safeToSpend")
            val available = budget?.optBoolean("available") == true
            return Summary(
                label = o.optJSONObject("range")?.optString("label").orEmpty(),
                rangeEnd = o.optJSONObject("range")?.optString("end").orEmpty(),
                income = totals.optLong("income"),
                expense = totals.optLong("expense"),
                /* Not safeToSpend.remaining: that is floored at zero, so a month
                   that spent more than it earned reads as nothing left. */
                net = totals.optLong("net"),
                accountsCounted = o.optInt("accountsCounted"),
                budgetIncome = if (available) budget!!.optLong("income") else null,
                budgetExpense = if (available) budget!!.optLong("expense") else null,
                budgetNet = if (available) budget!!.optLong("net") else null,
                perDay = safe?.optLong("perDay"),
                daysLeft = safe?.optInt("daysLeft"),
                byParent = totals.optJSONObject("byParent").cents(),
                budgetByParent = if (available) budget!!.optJSONObject("byParent").cents() else emptyMap(),
                byCategory = totals.optJSONObject("byCategory").cents(),
                budgetByCategory = if (available) budget!!.optJSONObject("byCategory").cents() else emptyMap(),
                previousExpense = o.optJSONObject("previous")?.optLong("expense"),
                comparison = o.optJSONObject("comparison")?.optString("label").orEmpty(),
                categories = Category.list(o.optJSONArray("categories")),
            )
        }
    }
}

data class Transaction(
    val id: String,
    val date: LocalDate,
    val name: String,
    val amount: Long,
    val pending: Boolean,
    val category: String,
    /** A filename for /api/logo, never a URL; null when Plaid has no art. */
    val logo: String?,
) {
    companion object {
        fun from(o: JSONObject) = Transaction(
            id = o.optString("id"),
            date = runCatching { LocalDate.parse(o.optString("date")) }.getOrDefault(LocalDate.now()),
            name = o.optString("name"),
            amount = o.optLong("amount"),
            pending = o.optBoolean("pending"),
            category = o.optString("category"),
            logo = if (o.isNull("logo")) null else o.optString("logo").ifBlank { null },
        )
    }
}

data class TransactionPage(
    val total: Int,
    val rows: List<Transaction>,
    val moneyIn: Long,
    val moneyOut: Long,
    val categories: List<Category>,
) {
    companion object {
        fun from(o: JSONObject): TransactionPage {
            val sum = o.optJSONObject("sum") ?: JSONObject()
            return TransactionPage(
                total = o.optInt("total"),
                rows = o.optJSONArray("transactions").orEmpty().map(Transaction::from),
                moneyIn = sum.optLong("in"),
                moneyOut = sum.optLong("out"),
                categories = Category.list(o.optJSONArray("categories")),
            )
        }
    }
}

data class BankAccount(val name: String, val mask: String?, val balance: Long?)

data class BankItem(
    val id: String,
    val institution: String,
    val needsSignIn: Boolean,
    val closed: Boolean,
    val awaitingFirstSync: Boolean,
    val accounts: List<BankAccount>,
)

data class Banks(val items: List<BankItem>, val trialUsed: Int?, val trialMax: Int?) {
    companion object {
        fun from(o: JSONObject): Banks {
            val trial = o.optJSONObject("trialBanks")
            return Banks(
                items = o.optJSONArray("items").orEmpty().map { item ->
                    BankItem(
                        id = item.optString("id"),
                        institution = item.optString("institution").ifBlank { "Bank" },
                        needsSignIn = item.optString("status").let { it.isNotBlank() && it != "good" },
                        closed = item.optBoolean("closed"),
                        awaitingFirstSync = item.optBoolean("awaitingFirstSync"),
                        accounts = item.optJSONArray("accounts").orEmpty().map { a ->
                            BankAccount(
                                name = a.optString("name"),
                                mask = a.optString("mask").ifBlank { null },
                                balance = if (a.isNull("currentBalance")) null else a.optLong("currentBalance"),
                            )
                        },
                    )
                },
                trialUsed = trial?.optInt("used"),
                trialMax = trial?.optInt("max"),
            )
        }
    }
}

data class SyncResult(val added: Int, val more: Boolean, val readOnly: Boolean, val pending: List<String>) {
    companion object {
        fun from(o: JSONObject) = SyncResult(
            added = o.optInt("added"),
            more = o.optBoolean("more"),
            readOnly = o.optBoolean("readOnly"),
            pending = o.optJSONArray("pending")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty(),
        )
    }
}

data class Billing(val plan: String, val planUntil: String?, val manageAt: String) {
    companion object {
        fun from(o: JSONObject) = Billing(
            plan = o.optString("plan"),
            planUntil = if (o.isNull("planUntil")) null else o.optString("planUntil").ifBlank { null },
            manageAt = o.optString("manageAt"),
        )
    }
}

/* JSONArray is not iterable, and every list here is read the same way. */
internal fun JSONArray?.orEmpty(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }

/* A {slug: cents} object, as a map. */
private fun JSONObject?.cents(): Map<String, Long> =
    if (this == null) emptyMap() else keys().asSequence().associateWith { optLong(it) }

/** Cents, as money. The API never sends anything else. */
fun Long.asMoney(withCents: Boolean = true): String {
    val negative = this < 0
    val cents = kotlin.math.abs(this)
    val whole = if (withCents) cents / 100 else (cents + 50) / 100
    val grouped = whole.toString().reversed().chunked(3).joinToString(",").reversed()
    val tail = if (withCents) "." + (cents % 100).toString().padStart(2, '0') else ""
    return (if (negative) "-$" else "$") + grouped + tail
}
