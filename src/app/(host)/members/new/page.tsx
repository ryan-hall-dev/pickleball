import type { Metadata } from "next";
import Link from "next/link";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { MemberForm } from "../MemberForm";

export const metadata: Metadata = {
  title: "Add a member · Pickleball Social Manager",
};

export default function AddMemberPage() {
  return (
    <>
      <Link
        href="/members"
        className="inline-flex min-h-11 items-center self-start font-semibold text-link hover:text-link-hover"
      >
        ← Members
      </Link>
      <section
        aria-labelledby="add-member-heading"
        className={`${CARD_CLASS_NAME} flex w-full max-w-[760px] flex-col gap-4`}
      >
        <h1
          id="add-member-heading"
          className="text-[32px] font-extrabold tracking-[-0.01em]"
        >
          Add a member
        </h1>
        <MemberForm />
      </section>
    </>
  );
}
