/**
 * The currencies a tier may be priced in, and which one each country uses.
 *
 * Mirrors `memberframe/src/utils/currencies.ts`: every circulating ISO 4217
 * currency, without funds, metals, or withdrawn codes. The two lists must hold
 * the same codes, or a tier the plugin lets a creator save is refused here.
 * Exponents live with the plugin, which parses what the creator types; the
 * server only ever sees integer minor units.
 */

import { z } from "zod";

export const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(
  (
    "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD " +
    "CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS " +
    "GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW " +
    "KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR " +
    "MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR " +
    "SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX " +
    "USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
  ).split(" ")
);

const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV",
  "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** Decimal places, the plugin's `currencyExponent`. Held equal to it by a test. */
export function currencyExponent(code: string): number {
  return ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
}

/**
 * An amount in one currency's minor units as the same number in another's:
 * 999 in USD (9.99) is 999 in EUR, 10 in JPY, 9990 in KWD. Rounded, so a
 * fraction a currency cannot hold becomes its nearest whole minor unit.
 */
export function rescaleMinor(amountMinor: number, from: string, to: string): number {
  const shift = currencyExponent(to) - currencyExponent(from);
  return Math.max(1, Math.round(amountMinor * 10 ** shift));
}

/** A supported currency code, for request bodies. */
export const currencySchema = z.string().refine((code) => SUPPORTED_CURRENCIES.has(code), "currency_unsupported");

/**
 * ISO 3166 country to the currency its buyers expect. Territories that use a
 * neighbour's currency map to it (Greenland to DKK, Puerto Rico to USD), and
 * countries where the US dollar is what people pay in (Panama, El Salvador,
 * Ecuador) map to USD.
 */
const COUNTRY_CURRENCY: ReadonlyMap<string, string> = new Map(
  (
    "AD:EUR AE:AED AF:AFN AG:XCD AI:XCD AL:ALL AM:AMD AO:AOA AR:ARS AS:USD AT:EUR AU:AUD AW:AWG " +
    "AX:EUR AZ:AZN BA:BAM BB:BBD BD:BDT BE:EUR BF:XOF BG:EUR BH:BHD BI:BIF BJ:XOF BL:EUR BM:BMD " +
    "BN:BND BO:BOB BQ:USD BR:BRL BS:BSD BT:BTN BW:BWP BY:BYN BZ:BZD CA:CAD CC:AUD CD:CDF CF:XAF " +
    "CG:XAF CH:CHF CI:XOF CK:NZD CL:CLP CM:XAF CN:CNY CO:COP CR:CRC CU:CUP CV:CVE CW:XCG CX:AUD " +
    "CY:EUR CZ:CZK DE:EUR DJ:DJF DK:DKK DM:XCD DO:DOP DZ:DZD EC:USD EE:EUR EG:EGP EH:MAD ER:ERN " +
    "ES:EUR ET:ETB FI:EUR FJ:FJD FK:FKP FM:USD FO:DKK FR:EUR GA:XAF GB:GBP GD:XCD GE:GEL GF:EUR " +
    "GG:GBP GH:GHS GI:GIP GL:DKK GM:GMD GN:GNF GP:EUR GQ:XAF GR:EUR GS:GBP GT:GTQ GU:USD GW:XOF " +
    "GY:GYD HK:HKD HN:HNL HR:EUR HT:HTG HU:HUF ID:IDR IE:EUR IL:ILS IM:GBP IN:INR IO:USD IQ:IQD " +
    "IR:IRR IS:ISK IT:EUR JE:GBP JM:JMD JO:JOD JP:JPY KE:KES KG:KGS KH:KHR KI:AUD KM:KMF KN:XCD " +
    "KP:KPW KR:KRW KW:KWD KY:KYD KZ:KZT LA:LAK LB:LBP LC:XCD LI:CHF LK:LKR LR:LRD LS:LSL LT:EUR " +
    "LU:EUR LV:EUR LY:LYD MA:MAD MC:EUR MD:MDL ME:EUR MF:EUR MG:MGA MH:USD MK:MKD ML:XOF MM:MMK " +
    "MN:MNT MO:MOP MP:USD MQ:EUR MR:MRU MS:XCD MT:EUR MU:MUR MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN " +
    "NA:NAD NC:XPF NE:XOF NF:AUD NG:NGN NI:NIO NL:EUR NO:NOK NP:NPR NR:AUD NU:NZD NZ:NZD OM:OMR " +
    "PA:USD PE:PEN PF:XPF PG:PGK PH:PHP PK:PKR PL:PLN PM:EUR PN:NZD PR:USD PS:ILS PT:EUR PW:USD " +
    "PY:PYG QA:QAR RE:EUR RO:RON RS:RSD RU:RUB RW:RWF SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK SG:SGD " +
    "SH:SHP SI:EUR SJ:NOK SK:EUR SL:SLE SM:EUR SN:XOF SO:SOS SR:SRD SS:SSP ST:STN SV:USD SX:XCG " +
    "SY:SYP SZ:SZL TC:USD TD:XAF TF:EUR TG:XOF TH:THB TJ:TJS TK:NZD TL:USD TM:TMT TN:TND TO:TOP " +
    "TR:TRY TT:TTD TV:AUD TW:TWD TZ:TZS UA:UAH UG:UGX UM:USD US:USD UY:UYU UZ:UZS VA:EUR VC:XCD " +
    "VE:VES VG:USD VI:USD VN:VND VU:VUV WF:XPF WS:WST XK:EUR YE:YER YT:EUR ZA:ZAR ZM:ZMW ZW:ZWG"
  )
    .split(" ")
    .map((pair) => pair.split(":") as [string, string])
);

/** The currency a buyer in this country would expect, or null for an unknown country. */
export function countryCurrency(country: string): string | null {
  return COUNTRY_CURRENCY.get(country.toUpperCase()) ?? null;
}

/**
 * Stripe's two exceptions. ISK and UGX are zero-decimal, and stored that way,
 * but Stripe's API still takes them as two-decimal values ending in 00: 5 ISK
 * is `amount: 500`. https://docs.stripe.com/currencies#special-cases
 */
const STRIPE_TWO_DECIMAL_LEGACY = new Set(["ISK", "UGX"]);

/** Stored minor units to the `amount` Stripe expects. */
export function toStripeAmount(amountMinor: number, currency: string): number {
  return STRIPE_TWO_DECIMAL_LEGACY.has(currency.toUpperCase()) ? amountMinor * 100 : amountMinor;
}

/** An `amount` Stripe reports back to stored minor units. */
export function fromStripeAmount(amount: number, currency: string): number {
  return STRIPE_TWO_DECIMAL_LEGACY.has(currency.toUpperCase()) ? Math.round(amount / 100) : amount;
}
