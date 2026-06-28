import {
  authorizationSchema,
  invoiceSchema,
  type CanonicalValue,
  type ResourceRequest,
} from "@x402-xec/core";
import { z } from "zod";

export const resourceRequestSchema = z.object({
  serverOrigin: z.string(),
  method: z.string(),
  path: z.string(),
  query: z.array(z.tuple([z.string(), z.string()])).optional(),
  body: z.json().optional(),
}).strict();

export const verifyRequestSchema = z.object({
  invoice: invoiceSchema,
  authorization: authorizationSchema,
  resource: resourceRequestSchema,
  idempotencyKey: z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, "idempotencyKey contains unsupported characters"),
}).strict();

export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

export function toResourceRequest(input: VerifyRequest["resource"]): ResourceRequest {
  return {
    serverOrigin: input.serverOrigin,
    method: input.method,
    path: input.path,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.body === undefined ? {} : { body: input.body as CanonicalValue }),
  };
}
