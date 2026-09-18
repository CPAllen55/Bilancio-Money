package com.bilanciomoney.bilancio

import org.json.JSONObject
import java.time.LocalDate
import java.time.YearMonth

/* The Trend, Budgeting and Calendar responses. Kept apart from Bilancio.kt so
   that file stays the client and this one the shapes the three screens read. */

/** A {key: cents} object, as a map. */
internal fun JSONObject?.centsMap(): Map<String, Long> =
    if (this == null) emptyMap() else keys().asSequence().associateWith { optLong(it) }

/* ------------------------------------------------------------------ trend -- */

data class TrendMonth(
    val month: YearMonth,
    val income: Long,
    val expense: Long,
    /** Spending by parent category. Nine stacked segments read as a shape;
        twenty-two read as noise, which is why the server rolls them up. */
    val byParent: Map<String, Long>,
) {
    companion object {
        fun from(o: JSONObject) = TrendMonth(
            month = runCatching { YearMonth.parse(o.optString("month")) }.getOrDefault(YearMonth.now()),
            income = o.optLong("income"),
            expense = o.optLong("expense"),
            byParent = o.optJSONObject("byParent").centsMap(),
        )
    }
}

/** `prior[i]` is the same calendar month as `series[i]`, a year earlier. */
data class Trend(val series: List<TrendMonth>, val prior: List<TrendMonth>, val categories: List<Category>) {
    companion object {
        fun from(o: JSONObject) = Trend(
            series = o.optJSONArray("series").orEmpty().map(TrendMonth::from),
            prior = o.optJSONArray("priorSeries").orEmpty().map(TrendMonth::from),
            categories = Category.list(o.optJSONArray("categories")),
        )
    }
}

/* ---------------------------------------------------------------- budget -- */

data class BudgetRow(
    val slug: String,
    val label: String,
    val colour: Long,
    val parentSlug: String?,
    /** month -> cents. The plan includes anything set by hand. */
    val plan: Map<String, Long>,
    /** month -> cents, for months already complete. */
    val spent: Map<String, Long>,
)

data class Budget(
    val months: List<String>,
    val currentMonth: String,
    val rows: List<BudgetRow>,
    val incomePlan: Map<String, Long>,
    val incomeSpent: Map<String, Long>,
    val savingsAnnual: Long,
) {
    companion object {
        fun from(o: JSONObject): Budget {
            val months = o.optJSONArray("months")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
            val income = o.optJSONObject("income")
            return Budget(
                months = months,
                currentMonth = o.optString("currentMonth"),
                rows = o.optJSONArray("categories").orEmpty().map { r ->
                    val c = Category.from(r)
                    BudgetRow(
                        slug = c.slug, label = c.label, colour = c.colour, parentSlug = c.parentSlug,
                        plan = r.optJSONObject("plan").centsMap(),
                        spent = r.optJSONObject("spent").centsMap(),
                    )
                },
                incomePlan = income?.optJSONObject("plan").centsMap(),
                incomeSpent = income?.optJSONObject("spent").centsMap(),
                savingsAnnual = o.optJSONObject("savings")?.optLong("annual") ?: 0L,
            )
        }
    }
}

/* -------------------------------------------------------------- calendar -- */

data class CalendarSub(val name: String, val cents: Long, val projected: Boolean)

data class CalendarDay(val date: LocalDate, val spent: Long, val count: Int, val subs: List<CalendarSub>)

data class CalendarMonth(val month: YearMonth, val days: List<CalendarDay>, val spent: Long, val subscriptions: Long) {
    companion object {
        fun from(o: JSONObject): CalendarMonth {
            val total = o.optJSONObject("total")
            return CalendarMonth(
                month = runCatching { YearMonth.parse(o.optString("month")) }.getOrDefault(YearMonth.now()),
                days = o.optJSONArray("days").orEmpty().map { d ->
                    CalendarDay(
                        date = LocalDate.parse(d.optString("date")),
                        spent = d.optLong("spent"),
                        count = d.optInt("count"),
                        subs = d.optJSONArray("subs").orEmpty().map { s ->
                            CalendarSub(s.optString("name"), s.optLong("cents"), s.optBoolean("projected"))
                        },
                    )
                },
                spent = total?.optLong("spent") ?: 0L,
                subscriptions = total?.optLong("subscriptions") ?: 0L,
            )
        }
    }
}
