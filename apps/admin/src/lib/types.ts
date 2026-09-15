import { z } from "zod";
import { UserIdentitySchema } from "@oao/shared";

/**
 * `GET /api/v1/admin/users` has a route in the contract but no response schema,
 * so the dashboard pins the shape it needs here. Keep it in sync with
 * `packages/shared/src/index.ts` if a schema is added there later.
 */
export const AdminUserSchema = UserIdentitySchema.extend({
  /** Number of audited actions over the queried period. */
  actions: z.number().int().nonnegative().default(0),
  lastActivityAt: z.string().optional(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUsersResponseSchema = z.union([
  z.array(AdminUserSchema),
  z.object({ items: z.array(AdminUserSchema) }).transform((v) => v.items),
]);

/** The two donut charts and the line chart share this shape. */
export interface SliceDatum {
  name: string;
  value: number;
  share: number;
  color: string;
}

export type DataMode = "live" | "mock";
