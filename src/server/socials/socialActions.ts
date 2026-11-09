"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import { shortLabelSchema } from "@/server/setup/setupRules";

// Writes use the service-role client, always after the caller is verified as
// the social's manager with getUser() (docs/decisions/0002-server-only-writes.md).
// The social is always the caller's own: never an id from the form.

export type UpdateSocialNameFormState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | {
      status: "error";
      message: string;
      fieldError?: string;
      submittedSocialName: string;
    };

const socialNameInputSchema = z.object({
  socialName: shortLabelSchema("Enter the social's name."),
});

const SOMETHING_WENT_WRONG = "Something went wrong. Try again in a moment.";

export async function updateSocialName(
  _previousState: UpdateSocialNameFormState,
  formData: FormData,
): Promise<UpdateSocialNameFormState> {
  const submittedValue = formData.get("socialName");
  const submittedSocialName =
    typeof submittedValue === "string" ? submittedValue : "";

  const authorization = await authorizeCurrentHost("manager");
  if (!authorization.ok) {
    return {
      status: "error",
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
      submittedSocialName,
    };
  }

  const parsed = socialNameInputSchema.safeParse({
    socialName: submittedSocialName,
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Fix the highlighted field.",
      fieldError: z.flattenError(parsed.error).fieldErrors.socialName?.[0],
      submittedSocialName,
    };
  }
  const { socialName } = parsed.data;

  try {
    const { data: updatedSocials, error } = await createSupabaseAdminClient()
      .from("socials")
      .update({ name: socialName })
      .eq("id", authorization.host.socialId)
      .select("id");
    if (error) throw new Error(`Renaming the social failed: ${error.message}`);
    if (updatedSocials.length !== 1) {
      throw new Error(
        `Renaming the social updated ${updatedSocials.length} rows.`,
      );
    }
  } catch (error) {
    console.error("Renaming a social failed", {
      actorUserId: authorization.host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "error",
      message: SOMETHING_WENT_WRONG,
      submittedSocialName,
    };
  }

  // The name shows in the header on every host page.
  revalidatePath("/", "layout");
  return { status: "success", message: `The social is now ${socialName}.` };
}
