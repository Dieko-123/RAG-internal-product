/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chats from "../chats.js";
import type * as crons from "../crons.js";
import type * as departments from "../departments.js";
import type * as fixtures_dummyManual from "../fixtures/dummyManual.js";
import type * as gemini from "../gemini.js";
import type * as ingestionJobs from "../ingestionJobs.js";
import type * as invites from "../invites.js";
import type * as invitesQueries from "../invitesQueries.js";
import type * as manuals from "../manuals.js";
import type * as permissions from "../permissions.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chats: typeof chats;
  crons: typeof crons;
  departments: typeof departments;
  "fixtures/dummyManual": typeof fixtures_dummyManual;
  gemini: typeof gemini;
  ingestionJobs: typeof ingestionJobs;
  invites: typeof invites;
  invitesQueries: typeof invitesQueries;
  manuals: typeof manuals;
  permissions: typeof permissions;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
