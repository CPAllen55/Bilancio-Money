package com.bilanciomoney.bilancio

import org.json.JSONObject

/* The Year ahead, Net Worth and Categories responses -- the screens under More. */

/* ---------------------------------------------------------------- forecast -- */

data class ForecastMonth(val month: String, val projected: Boolean, val income: Long, val expense: Long, val net: Long)

data class Forecast(
    val year: Int,
    val months: List<ForecastMonth>,
    val savedSoFar: Long,
    val remainingIncome: Long,
    val remainingExpense: Long,
    val yearEndNet: Long,
) {
    companion object {
        fun from(o: JSONObject): Forecast {
            val t = o.optJSONObject("totals") ?: JSONObject()
            return Forecast(
                year = o.optInt("year"),
                months = o.optJSONArray("months").orEmpty().map { m ->
                    ForecastMonth(
                        month = m.optString("month"),
                        projected = m.optBoolean("projected"),
                        income = m.optLong("income"),
                        expense = m.optLong("expense"),
                        net = m.optLong("net"),
                    )
                },
                savedSoFar = t.optLong("savedSoFar"),
                remainingIncome = t.optLong("projectedRemainingIncome"),
                remainingExpense = t.optLong("projectedRemainingExpense"),
                yearEndNet = t.optLong("projectedYearEndNet"),
            )
        }
    }
}

/* --------------------------------------------------------------- net worth -- */

data class WorthPoint(val month: String, val label: String, val assets: Long, val liabilities: Long, val netWorth: Long)

data class WorthGroup(val key: String, val label: String, val assets: Long, val liabilities: Long, val net: Long, val accounts: Int)

data class NetWorth(
    val assets: Long,
    val liabilities: Long,
    val netWorth: Long,
    val liquid: Long,
    val openingLabel: String,
    val change: Long,
    val changePct: Double?,
    val creditLimit: Long,
    val creditUsed: Long,
    /** False when some history was held flat rather than rebuilt from transactions. */
    val exact: Boolean,
    val series: List<WorthPoint>,
    val byClass: List<WorthGroup>,
    val byInstitution: List<WorthGroup>,
) {
    companion object {
        private fun group(g: JSONObject) = WorthGroup(
            key = g.optString("key"), label = g.optString("label"),
            assets = g.optLong("assets"), liabilities = g.optLong("liabilities"),
            net = g.optLong("net"), accounts = g.optInt("accounts"),
        )

        fun from(o: JSONObject): NetWorth {
            val t = o.optJSONObject("totals") ?: JSONObject()
            val change = o.optJSONObject("change") ?: JSONObject()
            val credit = o.optJSONObject("credit") ?: JSONObject()
            return NetWorth(
                assets = t.optLong("assets"),
                liabilities = t.optLong("liabilities"),
                netWorth = t.optLong("netWorth"),
                liquid = t.optLong("liquid"),
                openingLabel = o.optJSONObject("opening")?.optString("label").orEmpty(),
                change = change.optLong("netWorth"),
                changePct = if (change.isNull("netWorthPct")) null else change.optDouble("netWorthPct"),
                creditLimit = credit.optLong("limit"),
                creditUsed = credit.optLong("used"),
                exact = o.optJSONObject("coverage")?.optBoolean("exact") ?: true,
                series = o.optJSONArray("series").orEmpty().map { p ->
                    WorthPoint(p.optString("month"), p.optString("label"), p.optLong("assets"),
                        p.optLong("liabilities"), p.optLong("netWorth"))
                },
                byClass = o.optJSONArray("byClass").orEmpty().map(::group),
                byInstitution = o.optJSONArray("byInstitution").orEmpty().map(::group),
            )
        }
    }
}

/* -------------------------------------------------------------- categories -- */

data class Rule(val id: String, val displayName: String, val label: String, val colour: Long) {
    companion object {
        fun from(o: JSONObject) = Rule(
            id = o.optString("id"),
            displayName = o.optString("displayName").ifBlank { o.optString("matchKey") },
            label = o.optString("label"),
            colour = runCatching { 0xFF000000 or o.optString("colour").removePrefix("#").toLong(16) }
                .getOrDefault(0xFF888888),
        )
    }
}
