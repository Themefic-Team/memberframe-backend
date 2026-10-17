/** The one call `services/payments/gatewayRouter.ts` makes. The package ships no types. */
declare module "geoip-country" {
  export function lookup(ip: string): { country: string } | null;
  const geoip: { lookup: typeof lookup };
  export default geoip;
}
