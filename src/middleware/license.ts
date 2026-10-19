/**
 * The server half of the lock. F19, 19-pro-lock-and-trial.md 1.1.
 *
 * When a project's trial or plan has ended, its components blur on the page;
 * this makes the API agree, so editing the code file to remove the blur gains
 * nothing. Runs after `resolveSite`, on member sign in, sessions, checkout,
 * the meter, bookmarks, and downloads.
 *
 * Deliberately NOT on: gateway webhooks (a creator's own members' payments
 * must still be recorded), /api/preview (the creator still designs), the
 * Route Shield script, and anything the creator reaches from the panel.
 */

import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { ApiError } from "./errors.js";
import { siteLicense } from "../services/license/licenseService.js";

export const LICENSE_INACTIVE = "license_inactive";

export function requireActiveLicense(req: Request, _res: Response, next: NextFunction): void {
  if (!env.billing.enforce) {
    next();
    return;
  }
  const siteId = req.site?.id;
  if (!siteId) {
    next();
    return;
  }
  siteLicense(siteId)
    .then((license) => {
      if (license.licensed) next();
      else next(new ApiError(402, LICENSE_INACTIVE, "This site's MemberFrame plan has ended."));
    })
    .catch(next);
}
