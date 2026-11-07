"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  LINK_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { requestLoginCode, verifyLoginCode } from "@/server/auth/loginActions";
import {
  LOGIN_CODE_LENGTH,
  type RequestLoginCodeOutcome,
  type VerifyLoginCodeFailure,
} from "@/server/auth/loginCodeErrors";

const RESEND_COOLDOWN_SECONDS = 60;

const REQUEST_CODE_ERROR_MESSAGES: Record<
  Exclude<RequestLoginCodeOutcome, "CODE_SENT">,
  string
> = {
  INVALID_EMAIL: "Enter a valid email address.",
  RATE_LIMITED: "Too many sign-in attempts. Wait 10 minutes, then try again.",
  UNAVAILABLE: "We couldn't send a code just now. Try again in a moment.",
};

const VERIFY_CODE_ERROR_MESSAGES: Record<VerifyLoginCodeFailure, string> = {
  INVALID_CODE_FORMAT: `Enter the ${LOGIN_CODE_LENGTH}-digit code from the email.`,
  WRONG_OR_EXPIRED_CODE:
    "That code is wrong or has expired. Check it, or send a new code.",
  RATE_LIMITED: "Too many sign-in attempts. Wait 10 minutes, then try again.",
  UNAVAILABLE: "We couldn't check the code just now. Try again in a moment.",
};

type LoginStep = "enter_email" | "enter_code";
type FeedbackMessage = { tone: "error" | "info"; text: string } | null;

export function LoginForm() {
  const [step, setStep] = useState<LoginStep>("enter_email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [feedback, setFeedback] = useState<FeedbackMessage>(null);
  const [secondsUntilResend, setSecondsUntilResend] = useState(0);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (secondsUntilResend <= 0) return;
    const timer = setTimeout(
      () => setSecondsUntilResend((seconds) => seconds - 1),
      1000,
    );
    return () => clearTimeout(timer);
  }, [secondsUntilResend]);

  function sendCode(onSent: () => void) {
    startTransition(async () => {
      let outcome: RequestLoginCodeOutcome;
      try {
        outcome = await requestLoginCode(email);
      } catch {
        outcome = "UNAVAILABLE";
      }
      if (outcome === "CODE_SENT") {
        setSecondsUntilResend(RESEND_COOLDOWN_SECONDS);
        onSent();
      } else {
        setFeedback({
          tone: "error",
          text: REQUEST_CODE_ERROR_MESSAGES[outcome],
        });
      }
    });
  }

  function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    sendCode(() => {
      setCode("");
      setStep("enter_code");
    });
  }

  function handleResend() {
    setFeedback(null);
    sendCode(() =>
      setFeedback({
        tone: "info",
        text: "New code sent. Use the newest email.",
      }),
    );
  }

  function handleCodeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    startTransition(async () => {
      let failure: VerifyLoginCodeFailure;
      try {
        // On success the action redirects, so a result means it failed.
        const result = await verifyLoginCode(email, code);
        if (!result) return;
        failure = result.reason;
      } catch {
        failure = "UNAVAILABLE";
      }
      setFeedback({ tone: "error", text: VERIFY_CODE_ERROR_MESSAGES[failure] });
    });
  }

  function handleUseDifferentEmail() {
    setFeedback(null);
    setCode("");
    setStep("enter_email");
  }

  const feedbackId = "login-feedback";
  const hasError = feedback?.tone === "error";
  const feedbackRegion = (
    <div id={feedbackId} aria-live="polite" className="min-h-0">
      {feedback?.tone === "error" && (
        <AttentionMessage>{feedback.text}</AttentionMessage>
      )}
      {feedback?.tone === "info" && (
        <p className="text-sm text-lime-soft">{feedback.text}</p>
      )}
    </div>
  );

  if (step === "enter_email") {
    return (
      <form
        onSubmit={handleEmailSubmit}
        className="flex flex-col gap-5"
        noValidate
      >
        <div className="flex flex-col gap-1.5">
          <h1
            id="login-heading"
            className="text-[32px] font-extrabold tracking-[-0.01em]"
          >
            Host sign in
          </h1>
          <p className="text-muted">
            We&apos;ll email you a {LOGIN_CODE_LENGTH}-digit code. Hosts are
            invited by an admin.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-email" className={FIELD_LABEL_CLASS_NAME}>
            Email
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={isPending}
            aria-invalid={hasError || undefined}
            aria-describedby={hasError ? feedbackId : undefined}
            className={TEXT_INPUT_CLASS_NAME}
          />
        </div>
        {feedbackRegion}
        <button
          type="submit"
          disabled={isPending || email.trim() === ""}
          className={PRIMARY_BUTTON_CLASS_NAME}
        >
          {isPending ? "Sending code…" : "Send code"}
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={handleCodeSubmit}
      className="flex flex-col gap-5"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <h1
          id="login-heading"
          className="text-[32px] font-extrabold tracking-[-0.01em]"
        >
          Check your email
        </h1>
        <p className="text-muted">
          If <strong className="font-semibold text-text">{email.trim()}</strong>{" "}
          is on the hosts list, a {LOGIN_CODE_LENGTH}-digit code is on its way.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-code" className={FIELD_LABEL_CLASS_NAME}>
          {LOGIN_CODE_LENGTH}-digit code
        </label>
        <input
          id="login-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={LOGIN_CODE_LENGTH + 2}
          required
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={isPending}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? feedbackId : undefined}
          className={`${TEXT_INPUT_CLASS_NAME} text-xl font-bold tracking-[0.3em] tabular-nums`}
        />
      </div>
      {feedbackRegion}
      <button
        type="submit"
        disabled={isPending || code.trim() === ""}
        className={PRIMARY_BUTTON_CLASS_NAME}
      >
        {isPending ? "Checking…" : "Sign in"}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <button
          type="button"
          onClick={handleResend}
          disabled={isPending || secondsUntilResend > 0}
          className={LINK_BUTTON_CLASS_NAME}
        >
          {secondsUntilResend > 0
            ? `Send a new code in ${secondsUntilResend}s`
            : "Send a new code"}
        </button>
        <button
          type="button"
          onClick={handleUseDifferentEmail}
          disabled={isPending}
          className={LINK_BUTTON_CLASS_NAME}
        >
          Use a different email
        </button>
      </div>
    </form>
  );
}
