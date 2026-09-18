package com.bilanciomoney.bilancio

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.queryProductDetails
import com.android.billingclient.api.queryPurchasesAsync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Google Play Billing: what can be bought, buying it, and handing every
 * purchase to our server -- which asks Google whether it is real, records the
 * plan and acknowledges it (see src/google.ts). Nothing here decides who has
 * paid; the app only ever shows what the server says.
 *
 * One subscription product with two base plans, "monthly" and "yearly", so
 * switching between them is a plan change Google prorates rather than a second
 * subscription.
 */
object PlayStore {
    const val PRODUCT_ID = "bilancio_subscription"

    /** One way to pay, as Play prices it for this person's country. */
    data class Plan(
        val basePlanId: String,
        val offerToken: String,
        val price: String,
        val micros: Long,
        val period: String,
        val currency: String,
    )

    /** Set after a purchase is handed to the server: the plan it now reports. */
    private val _changed = MutableStateFlow(0)
    val changed: StateFlow<Int> = _changed

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var client: BillingClient? = null
    private var details: ProductDetails? = null

    private fun client(context: Context): BillingClient =
        client ?: BillingClient.newBuilder(context.applicationContext)
            .setListener { result, purchases -> onPurchases(result, purchases) }
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build()
            .also { client = it }

    private suspend fun ready(context: Context): BillingClient? {
        val c = client(context)
        if (c.isReady) return c
        val ok = suspendCancellableCoroutine { cont ->
            c.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (cont.isActive) cont.resume(result.responseCode == BillingClient.BillingResponseCode.OK)
                }
                override fun onBillingServiceDisconnected() {
                    if (cont.isActive) cont.resume(false)
                }
            })
        }
        return if (ok) c else null
    }

    /** The two plans, cheapest first; empty when Play has nothing to sell yet. */
    suspend fun plans(context: Context): List<Plan> {
        val c = ready(context) ?: return emptyList()
        val params = QueryProductDetailsParams.newBuilder().setProductList(
            listOf(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(PRODUCT_ID)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build(),
            ),
        ).build()
        val product = c.queryProductDetails(params).productDetailsList?.firstOrNull() ?: return emptyList()
        details = product
        /* The base plans themselves, not offers layered on them: the free trial
           is Bilancio's own and already running on the server. */
        return product.subscriptionOfferDetails.orEmpty()
            .filter { it.offerId == null }
            .mapNotNull { o ->
                val phase = o.pricingPhases.pricingPhaseList.lastOrNull() ?: return@mapNotNull null
                Plan(o.basePlanId, o.offerToken, phase.formattedPrice, phase.priceAmountMicros, phase.billingPeriod, phase.priceCurrencyCode)
            }
            .sortedBy { it.micros }
    }

    /**
     * Opens Play's purchase sheet. The Bilancio user id goes with it, and
     * Google hands it back to the server as proof of whose purchase it is.
     * When a Play subscription is already held, this is a switch of plan.
     */
    suspend fun buy(activity: Activity, plan: Plan, accountId: String): String? {
        val c = ready(activity) ?: return "Google Play isn't available on this device."
        val product = details ?: return "Plans haven't loaded yet."
        val current = owned(activity).firstOrNull()
        val flow = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(
                listOf(
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(product)
                        .setOfferToken(plan.offerToken)
                        .apply {
                            /* Switching monthly and yearly: the unused time on
                               the old plan is credited toward the new one. */
                            if (current != null) {
                                setSubscriptionProductReplacementParams(
                                    BillingFlowParams.ProductDetailsParams.SubscriptionProductReplacementParams.newBuilder()
                                        .setOldProductId(PRODUCT_ID)
                                        .setReplacementMode(
                                            BillingFlowParams.ProductDetailsParams.SubscriptionProductReplacementParams.ReplacementMode.WITH_TIME_PRORATION,
                                        )
                                        .build(),
                                )
                            }
                        }
                        .build(),
                ),
            )
            .setObfuscatedAccountId(accountId)
            .apply {
                if (current != null) {
                    setSubscriptionUpdateParams(
                        BillingFlowParams.SubscriptionUpdateParams.newBuilder()
                            .setOldPurchaseToken(current.purchaseToken)
                            .build(),
                    )
                }
            }
            .build()
        val result = c.launchBillingFlow(activity, flow)
        return if (result.responseCode == BillingClient.BillingResponseCode.OK) null else result.debugMessage.ifBlank { null }
    }

    private suspend fun owned(context: Context): List<Purchase> {
        val c = ready(context) ?: return emptyList()
        return c.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(),
        ).purchasesList.filter { PRODUCT_ID in it.products }
    }

    /**
     * Hands every purchase this Google account holds to the server. Run each
     * time the app opens, so a renewal, a plan change or a purchase whose
     * hand-over was interrupted is caught up -- the Play equivalent of the
     * iPhone's transaction listener.
     */
    suspend fun sync(context: Context) {
        runCatching {
            for (p in owned(context)) {
                if (p.purchaseState == Purchase.PurchaseState.PURCHASED) Bilancio.googlePurchase(p.purchaseToken)
            }
            _changed.value++
        }
    }

    private fun onPurchases(result: BillingResult, purchases: List<Purchase>?) {
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> scope.launch {
                for (p in purchases.orEmpty()) {
                    when (p.purchaseState) {
                        Purchase.PurchaseState.PURCHASED ->
                            runCatching { Bilancio.googlePurchase(p.purchaseToken) }
                                .onSuccess { _message.value = "You're subscribed. Thank you." }
                                .onFailure { _message.value = it.message }
                        Purchase.PurchaseState.PENDING ->
                            _message.value = "Your payment is pending with Google Play. Access starts once it clears."
                        else -> {}
                    }
                }
                _changed.value++
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> {}
            else -> _message.value = result.debugMessage.ifBlank { "Google Play couldn't complete the purchase." }
        }
    }

    fun clearMessage() { _message.value = null }
}
