"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import {
  HOST_ACCESS_DENIAL_MESSAGES,
  type SignedInHost,
} from "@/server/auth/hostAccess";
import {
  CONFIRM_DUPLICATE_NAME_FIELD,
  duplicateNameWarning,
  isSameFullName,
  memberFullNameKey,
  memberInputSchema,
  type MemberInput,
} from "./memberRules";

// Any host may manage the member directory (plan §4: "Hosts can search, edit
// and deactivate"). Members are never deleted. Writes use the service-role
// client, always after the caller is verified as a host with getUser()
// (docs/decisions/0002-server-only-writes.md).

export interface MemberFormValues {
  firstName: string;
  lastName: string;
  skillLevel: string;
}

export type MemberFormFieldErrors = Partial<
  Record<keyof MemberFormValues, string>
>;

export type MemberFormState =
  | { status: "idle" }
  | {
      status: "error";
      message: string;
      fieldErrors: MemberFormFieldErrors;
      submittedValues: MemberFormValues;
    }
  /** Nothing saved: an active member has the same name. Resubmit with the confirmation to save. */
  | {
      status: "duplicate_name";
      message: string;
      /** The warned name's key; "Save anyway" sends it back to confirm that name. */
      duplicateNameKey: string;
      submittedValues: MemberFormValues;
    };

export type MemberActiveFormState =
  { status: "idle" } | { status: "error"; message: string };

const MEMBERS_PATH = "/members";
const POSTGRES_CHECK_VIOLATION = "23514";
const SOMETHING_WENT_WRONG = "Something went wrong. Try again in a moment.";
const MEMBER_NOT_FOUND = "This member no longer exists. Go back to Members.";
const NAME_REFUSED_BY_DATABASE =
  "Check the names: up to 50 characters each, no special characters.";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

function formText(formData: FormData, fieldName: string): string {
  const value = formData.get(fieldName);
  return typeof value === "string" ? value : "";
}

function memberPath(memberId: string): string {
  return `${MEMBERS_PATH}/${memberId}`;
}

function savedMemberHref(memberId: string): string {
  return `${MEMBERS_PATH}?saved=${memberId}`;
}

type ValidatedMemberForm =
  | { ok: false; state: MemberFormState }
  | {
      ok: true;
      host: SignedInHost;
      memberInput: MemberInput;
      isDuplicateNameConfirmed: boolean;
      formError: (message: string) => MemberFormState;
      duplicateNameState: () => MemberFormState;
    };

/** Authorises the caller first, then validates the add/edit form. */
async function validateMemberForm(
  formData: FormData,
): Promise<ValidatedMemberForm> {
  const submittedValues: MemberFormValues = {
    firstName: formText(formData, "firstName"),
    lastName: formText(formData, "lastName"),
    skillLevel: formText(formData, "skillLevel"),
  };
  const formError = (
    message: string,
    fieldErrors: MemberFormFieldErrors = {},
  ): MemberFormState => ({
    status: "error",
    message,
    fieldErrors,
    submittedValues,
  });

  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      state: formError(HOST_ACCESS_DENIAL_MESSAGES[authorization.reason]),
    };
  }

  const parsed = memberInputSchema.safeParse(submittedValues);
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    return {
      ok: false,
      state: formError("Fix the highlighted fields.", {
        firstName: fieldErrors.firstName?.[0],
        lastName: fieldErrors.lastName?.[0],
        skillLevel: fieldErrors.skillLevel?.[0],
      }),
    };
  }
  const memberInput = parsed.data;
  const fullNameKey = memberFullNameKey(memberInput);

  return {
    ok: true,
    host: authorization.host,
    memberInput,
    // Only confirms the name that was warned about: a name edited after the
    // warning gets checked again.
    isDuplicateNameConfirmed:
      formText(formData, CONFIRM_DUPLICATE_NAME_FIELD) === fullNameKey,
    formError: (message) => formError(message),
    duplicateNameState: () => ({
      status: "duplicate_name",
      message: duplicateNameWarning(
        `${memberInput.firstName} ${memberInput.lastName}`,
      ),
      duplicateNameKey: fullNameKey,
      submittedValues,
    }),
  };
}

/**
 * Whether another active member has the same name once case, accents and
 * spacing are ignored (an exact match on the generated `search_name`).
 */
async function activeMemberWithSameNameExists(
  adminClient: AdminClient,
  memberInput: MemberInput,
  excludedMemberId: string | null,
): Promise<boolean> {
  let builder = adminClient
    .from("members")
    .select("id")
    .eq("is_active", true)
    .eq("search_name", memberFullNameKey(memberInput))
    .limit(1);
  if (excludedMemberId) builder = builder.neq("id", excludedMemberId);
  const { data, error } = await builder;
  if (error)
    throw new Error(`Checking for duplicates failed: ${error.message}`);
  return data.length > 0;
}

function logWriteFailure(label: string, host: SignedInHost, error: unknown) {
  // Ids only: member names are personal data.
  console.error(label, {
    actorUserId: host.userId,
    cause: error instanceof Error ? error.message : String(error),
  });
}

export async function createMember(
  _previousState: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const validated = await validateMemberForm(formData);
  if (!validated.ok) return validated.state;
  const { host, memberInput, formError } = validated;

  let createdMemberId: string;
  try {
    const adminClient = createSupabaseAdminClient();
    if (
      !validated.isDuplicateNameConfirmed &&
      (await activeMemberWithSameNameExists(adminClient, memberInput, null))
    ) {
      return validated.duplicateNameState();
    }
    const { data, error } = await adminClient
      .from("members")
      .insert({
        first_name: memberInput.firstName,
        last_name: memberInput.lastName,
        skill_level: memberInput.skillLevel,
      })
      .select("id")
      .single();
    if (error?.code === POSTGRES_CHECK_VIOLATION) {
      return formError(NAME_REFUSED_BY_DATABASE);
    }
    if (error) throw new Error(`Adding the member failed: ${error.message}`);
    createdMemberId = data.id;
  } catch (error) {
    logWriteFailure("Adding a member failed", host, error);
    return formError(SOMETHING_WENT_WRONG);
  }

  revalidatePath(MEMBERS_PATH);
  redirect(savedMemberHref(createdMemberId));
}

export async function updateMember(
  _previousState: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const validated = await validateMemberForm(formData);
  if (!validated.ok) return validated.state;
  const { host, memberInput, formError } = validated;

  const parsedMemberId = z.uuid().safeParse(formText(formData, "memberId"));
  if (!parsedMemberId.success) return formError(MEMBER_NOT_FOUND);
  const memberId = parsedMemberId.data;

  try {
    const adminClient = createSupabaseAdminClient();
    const { data: currentMember, error: readError } = await adminClient
      .from("members")
      .select("first_name, last_name")
      .eq("id", memberId)
      .maybeSingle();
    if (readError) {
      throw new Error(`Reading the member failed: ${readError.message}`);
    }
    if (!currentMember) return formError(MEMBER_NOT_FOUND);

    // Only a name change can create a new duplicate; editing just the skill
    // of an existing namesake shouldn't warn every time.
    const isNameChanged = !isSameFullName(memberInput, {
      firstName: currentMember.first_name,
      lastName: currentMember.last_name,
    });
    if (
      isNameChanged &&
      !validated.isDuplicateNameConfirmed &&
      (await activeMemberWithSameNameExists(adminClient, memberInput, memberId))
    ) {
      return validated.duplicateNameState();
    }

    const { data: updatedRows, error } = await adminClient
      .from("members")
      .update({
        first_name: memberInput.firstName,
        last_name: memberInput.lastName,
        skill_level: memberInput.skillLevel,
      })
      .eq("id", memberId)
      .select("id");
    if (error?.code === POSTGRES_CHECK_VIOLATION) {
      return formError(NAME_REFUSED_BY_DATABASE);
    }
    if (error) throw new Error(`Updating the member failed: ${error.message}`);
    if (updatedRows.length === 0) return formError(MEMBER_NOT_FOUND);
  } catch (error) {
    logWriteFailure("Updating a member failed", host, error);
    return formError(SOMETHING_WENT_WRONG);
  }

  revalidatePath(MEMBERS_PATH);
  revalidatePath(memberPath(memberId));
  redirect(savedMemberHref(memberId));
}

/** Deactivate (hide from check-in and the active list) or reactivate. Never deletes. */
export async function setMemberActive(
  _previousState: MemberActiveFormState,
  formData: FormData,
): Promise<MemberActiveFormState> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      status: "error",
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }

  const parsedInput = z
    .object({
      memberId: z.uuid(),
      isActive: z.enum(["true", "false"]),
    })
    .safeParse({
      memberId: formText(formData, "memberId"),
      isActive: formText(formData, "isActive"),
    });
  if (!parsedInput.success) {
    return { status: "error", message: MEMBER_NOT_FOUND };
  }
  const { memberId } = parsedInput.data;

  try {
    const { data: updatedRows, error } = await createSupabaseAdminClient()
      .from("members")
      .update({ is_active: parsedInput.data.isActive === "true" })
      .eq("id", memberId)
      .select("id");
    if (error) {
      throw new Error(`Changing member status failed: ${error.message}`);
    }
    if (updatedRows.length === 0) {
      return { status: "error", message: MEMBER_NOT_FOUND };
    }
  } catch (error) {
    logWriteFailure(
      "Changing a member's status failed",
      authorization.host,
      error,
    );
    return { status: "error", message: SOMETHING_WENT_WRONG };
  }

  revalidatePath(MEMBERS_PATH);
  revalidatePath(memberPath(memberId));
  return { status: "idle" };
}
