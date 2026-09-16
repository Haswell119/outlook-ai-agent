import { z } from "zod";
import { AdminUserSchema } from "@oao/shared";
export { AdminUserSchema };
export type { AdminUser } from "@oao/shared";

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
