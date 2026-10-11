// Every sticker price in one place. Each can be overridden with an environment variable, so prices
// change without a code change. All money is in paise (₹1 = 100 paise).
//
// Stickers are bought, never "spent from a balance": each plan is paid for through Razorpay and
// adds stickers to that plan's own balance (its tab on the Generate page).
//
// LIGHT is the Pay As You Go balance for light QR stickers: bought the same way, used only by
// "Generate light QR stickers" (never by the regular sticker tabs).
const PLAN_TYPES = ['PAYG', 'SUBSCRIPTION', 'FIXED_VARIABLE', 'LIGHT'];
const STICKER_SOURCES = ['PAYG', 'SUBSCRIPTION', 'FIXED_VARIABLE']; // what "Generate QR stickers" can use
const BILLING_CYCLES = ['MONTHLY', 'YEARLY'];
const PLAN_NAMES = { PAYG: 'Pay As You Go', SUBSCRIPTION: 'Subscription', FIXED_VARIABLE: 'Fixed + Variable', LIGHT: 'Light QR' };

const positiveInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const planConfig = () => {
  const discount = Number(process.env.PLAN_YEARLY_DISCOUNT_PCT);
  return {
    // Pay As You Go — stickers valid for two years from purchase.
    payg: {
      pricePerQrPaise: positiveInt('QR_PRICE_PAISE', 2000), // ₹20
      minQr: positiveInt('PLAN_PAYG_MIN_QR', 5),
      maxQr: positiveInt('PLAN_PAYG_MAX_QR', 10000),
      validityMonths: positiveInt('PLAN_PAYG_VALIDITY_MONTHS', 24),
    },
    // Light QR stickers, Pay As You Go: every sticker in a purchase costs ₹15 when it's up to 1,000
    // stickers, ₹10 above that. Valid for two years from purchase.
    light: {
      pricePerQrPaise: positiveInt('PLAN_LIGHT_PRICE_PAISE', 1500), // ₹15
      tierQr: positiveInt('PLAN_LIGHT_TIER_QR', 1000),
      priceAboveTierPaise: positiveInt('PLAN_LIGHT_PRICE_ABOVE_TIER_PAISE', 1000), // ₹10
      minQr: positiveInt('PLAN_LIGHT_MIN_QR', 1),
      maxQr: positiveInt('PLAN_LIGHT_MAX_QR', 10000),
      validityMonths: positiveInt('PLAN_LIGHT_VALIDITY_MONTHS', 24),
    },
    // Volume price: every QR costs ₹15 when the monthly quantity is up to 1,000, ₹10 above that.
    subscription: {
      pricePerQrPaise: positiveInt('PLAN_SUB_PRICE_PER_QR_PAISE', 1500), // ₹15 per QR per month
      tierQr: positiveInt('PLAN_SUB_TIER_QR', 1000),
      priceAboveTierPaise: positiveInt('PLAN_SUB_PRICE_ABOVE_TIER_PAISE', 1000), // ₹10 per QR per month
      minQr: positiveInt('PLAN_SUB_MIN_QR', 100),
      maxQr: positiveInt('PLAN_SUB_MAX_QR', 10000),
      stepQr: positiveInt('PLAN_SUB_STEP_QR', 1), // any whole number by default
    },
    // ₹10,000 for the month's 1,100 stickers, plus any extra bought with it or later in the month:
    // the first 1,000 extras of a month at ₹15 each, the rest at ₹10.
    fixed: {
      feePaise: positiveInt('PLAN_FIXED_FEE_PAISE', 1000000), // ₹10,000 per month
      includedQr: positiveInt('PLAN_FIXED_INCLUDED_QR', 1100),
      extraPricePaise: positiveInt('PLAN_FIXED_EXTRA_PAISE', 1500), // ₹15 per QR beyond the included
      extraTierQr: positiveInt('PLAN_FIXED_EXTRA_TIER_QR', 1000),
      extraPriceAboveTierPaise: positiveInt('PLAN_FIXED_EXTRA_ABOVE_TIER_PAISE', 1000), // ₹10
      maxExtraQr: positiveInt('PLAN_FIXED_MAX_EXTRA_QR', 100000),
      minAddQr: positiveInt('PLAN_FIXED_MIN_ADD_QR', 10), // smallest top-up of an active month
    },
    // Yearly = 12 months paid upfront at this discount — Subscription only (Fixed + Variable is monthly).
    yearlyDiscountPct: Number.isInteger(discount) && discount >= 0 && discount < 100 ? discount : 20,
  };
};

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const qty = (n) => n.toLocaleString('en-IN');

// Subscription: the price of each QR for a monthly quantity.
const subPricePerQr = (quota, sub = planConfig().subscription) =>
  quota <= sub.tierQr ? sub.pricePerQrPaise : sub.priceAboveTierPaise;

// Fixed + Variable: the price of `count` extras when `alreadyBought` extras were bought this month.
const fixedExtrasPaise = (count, alreadyBought, fixed = planConfig().fixed) => {
  const atFull = Math.max(0, Math.min(count, fixed.extraTierQr - alreadyBought));
  return atFull * fixed.extraPricePaise + (count - atFull) * fixed.extraPriceAboveTierPaise;
};

const checkRange = (n, min, max, what) => {
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, `Choose between ${qty(min)} and ${qty(max)} ${what}.`);
  }
};

// What a purchase gives and costs. `quantity` means: Pay As You Go — stickers; Subscription —
// stickers per month; Fixed + Variable — extras beyond the included stickers. `fixedExtrasBought`
// is the extras already bought in the user's running Fixed + Variable month (null when none is
// running): then the purchase only adds extras to that month, with no fee.
const quotePurchase = ({ planType, billingCycle, quantity }, { fixedExtrasBought = null } = {}) => {
  const config = planConfig();
  const n = Number(quantity);
  if (!PLAN_TYPES.includes(planType)) throw httpError(400, 'Choose a valid plan.');

  if (planType === 'PAYG') {
    const { pricePerQrPaise, minQr, maxQr } = config.payg;
    checkRange(n, minQr, maxQr, 'stickers');
    return {
      planType,
      billingCycle: null,
      quantity: n,
      stickers: n,
      amountPaise: n * pricePerQrPaise,
      description: `${PLAN_NAMES.PAYG} · ${qty(n)} stickers`,
    };
  }

  if (planType === 'LIGHT') {
    const { pricePerQrPaise, tierQr, priceAboveTierPaise, minQr, maxQr } = config.light;
    checkRange(n, minQr, maxQr, 'light QR stickers');
    return {
      planType,
      billingCycle: null,
      quantity: n,
      stickers: n,
      amountPaise: n * (n <= tierQr ? pricePerQrPaise : priceAboveTierPaise),
      description: `${PLAN_NAMES.LIGHT} · ${qty(n)} stickers`,
    };
  }

  if (planType === 'SUBSCRIPTION') {
    if (!BILLING_CYCLES.includes(billingCycle)) throw httpError(400, 'Choose monthly or yearly billing.');
    const { minQr, maxQr, stepQr } = config.subscription;
    checkRange(n, minQr, maxQr, 'QR codes a month');
    if (n % stepQr !== 0) throw httpError(400, `Choose the QR codes a month in steps of ${qty(stepQr)}.`);
    const yearly = billingCycle === 'YEARLY';
    const monthlyPaise = n * subPricePerQr(n, config.subscription);
    return {
      planType,
      billingCycle,
      quantity: n,
      stickers: n, // this month's; a yearly plan refills to n at the start of each month
      months: yearly ? 12 : 1,
      amountPaise: yearly ? Math.round((monthlyPaise * 12 * (100 - config.yearlyDiscountPct)) / 100) : monthlyPaise,
      description: `${PLAN_NAMES.SUBSCRIPTION} · ${qty(n)} a month · ${yearly ? 'Yearly' : 'Monthly'}`,
    };
  }

  const { feePaise, includedQr, maxExtraQr, minAddQr } = config.fixed;
  const addOn = fixedExtrasBought !== null;
  checkRange(n, addOn ? minAddQr : 0, maxExtraQr, addOn ? 'more stickers' : 'additional stickers');
  return {
    planType,
    billingCycle: 'MONTHLY',
    quantity: n,
    addOn,
    extras: n,
    stickers: addOn ? n : includedQr + n,
    amountPaise: (addOn ? 0 : feePaise) + fixedExtrasPaise(n, addOn ? fixedExtrasBought : 0, config.fixed),
    description: addOn
      ? `${PLAN_NAMES.FIXED_VARIABLE} · ${qty(n)} more stickers this month`
      : `${PLAN_NAMES.FIXED_VARIABLE} · ${qty(includedQr)}${n ? ` + ${qty(n)} extra` : ''} stickers`,
  };
};

module.exports = { PLAN_TYPES, STICKER_SOURCES, BILLING_CYCLES, PLAN_NAMES, planConfig, subPricePerQr, fixedExtrasPaise, quotePurchase };
