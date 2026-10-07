/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    attempts: {
      consume: FunctionReference<
        "mutation",
        "internal",
        { binding: string; id: string },
        {
          ciphertext: ArrayBuffer;
          format: "aes-gcm-v1";
          iv: ArrayBuffer;
        } | null,
        Name
      >;
      save: FunctionReference<
        "mutation",
        "internal",
        {
          binding: string;
          envelope: {
            ciphertext: ArrayBuffer;
            format: "aes-gcm-v1";
            iv: ArrayBuffer;
          };
          expiresAt: number;
          id: string;
        },
        null,
        Name
      >;
    };
    records: {
      claim: FunctionReference<
        "mutation",
        "internal",
        {
          expectedVersion: number;
          key: string;
          leaseMs: number;
          owner: string;
        },
        | { claimed: true; fence: number; leaseUntil: number; version: number }
        | { claimed: false },
        Name
      >;
      complete: FunctionReference<
        "mutation",
        "internal",
        {
          envelope: {
            ciphertext: ArrayBuffer;
            format: "aes-gcm-v1";
            iv: ArrayBuffer;
          };
          expiresAt: number;
          fence: number;
          key: string;
          owner: string;
          writeId: string;
        },
        {
          status: "committed" | "already-applied" | "conflict";
          version: number;
        },
        Name
      >;
      fakeExchange: FunctionReference<
        "mutation",
        "internal",
        { key: string; refreshToken: string },
        { accessToken: string; expiresAt: number; refreshToken: string },
        Name
      >;
      initialize: FunctionReference<
        "mutation",
        "internal",
        {
          envelope: {
            ciphertext: ArrayBuffer;
            format: "aes-gcm-v1";
            iv: ArrayBuffer;
          };
          expiresAt: number;
          key: string;
        },
        null,
        Name
      >;
      inspect: FunctionReference<
        "query",
        "internal",
        { key: string },
        { credentialWorkPending: boolean; savedAuthorization: boolean },
        Name
      >;
      providerCalls: FunctionReference<
        "query",
        "internal",
        { key: string },
        number,
        Name
      >;
      providerRequests: FunctionReference<
        "query",
        "internal",
        { key: string },
        number,
        Name
      >;
      read: FunctionReference<
        "query",
        "internal",
        { key: string },
        {
          envelope: {
            ciphertext: ArrayBuffer;
            format: "aes-gcm-v1";
            iv: ArrayBuffer;
          };
          expiresAt: number;
          fence: number;
          key: string;
          lastCompletionFence: number | null;
          lastCompletionId: string | null;
          lastCompletionOwner: string | null;
          leaseUntil: number | null;
          owner: string | null;
          version: number;
        } | null,
        Name
      >;
      recordHttpAttempt: FunctionReference<
        "mutation",
        "internal",
        { key: string },
        null,
        Name
      >;
      renew: FunctionReference<
        "mutation",
        "internal",
        { fence: number; key: string; leaseMs: number; owner: string },
        boolean,
        Name
      >;
    };
  };
