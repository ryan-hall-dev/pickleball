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
import { useMessages } from "@/i18n/LocaleProvider";
import type { Messages } from "@/i18n/messages";

const RESEND_COOLDOWN_SECONDS = 60;

type LoginText = Messages["host"]["login"];

function requestCodeErrorText(
  outcome: Exclude<RequestLoginCodeOutcome, "CODE_SENT">,
  text: LoginText,
): string {
  return {
    INVALID_EMAIL: text.errors.invalidEmail,
    RATE_LIMITED: text.errors.rateLimited,
    UNAVAILABLE: text.errors.sendUnavailable,
  }[outcome];
}

function verifyCodeErrorText(
  failure: VerifyLoginCodeFailure,
  text: LoginText,
): string {
  return {
    INVALID_CODE_FORMAT: text.errors.invalidCodeFormat(LOGIN_CODE_LENGTH),
    WRONG_OR_EXPIRED_CODE: text.errors.wrongOrExpired,
    RATE_LIMITED: text.errors.rateLimited,
    UNAVAILABLE: text.errors.checkUnavailable,
  }[failure];
}

type LoginStep = "enter_email" | "enter_code";
/** Kept as a reason, so it follows a language switch. */
type FeedbackMessage =
  | { tone: "error"; request: Exclude<RequestLoginCodeOutcome, "CODE_SENT"> }
  | { tone: "error"; verify: VerifyLoginCodeFailure }
  | { tone: "info" }
  | null;

export function LoginForm() {
  const text = useMessages().host.login;
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
        setFeedback({ tone: "error", request: outcome });
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
    sendCode(() => setFeedback({ tone: "info" }));
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
      setFeedback({ tone: "error", verify: failure });
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
        <AttentionMessage>
          {"request" in feedback
            ? requestCodeErrorText(feedback.request, text)
            : verifyCodeErrorText(feedback.verify, text)}
        </AttentionMessage>
      )}
      {feedback?.tone === "info" && (
        <p className="text-sm text-lime-soft">{text.newCodeSent}</p>
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
            className="text-[32px] font-extrabold tracking-[-0.01em] compact:text-2xl"
          >
            {text.title}
          </h1>
          <p className="text-muted">{text.intro(LOGIN_CODE_LENGTH)}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-email" className={FIELD_LABEL_CLASS_NAME}>
            {text.email}
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
          {isPending ? text.sendingCode : text.sendCode}
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
          className="text-[32px] font-extrabold tracking-[-0.01em] compact:text-2xl"
        >
          {text.checkEmailTitle}
        </h1>
        <p className="text-muted">
          {text.codeOnItsWayBefore}{" "}
          <strong className="font-semibold text-text">{email.trim()}</strong>{" "}
          {text.codeOnItsWayAfter(LOGIN_CODE_LENGTH)}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-code" className={FIELD_LABEL_CLASS_NAME}>
          {text.codeLabel(LOGIN_CODE_LENGTH)}
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
          className={`${TEXT_INPUT_CLASS_NAME} text-xl font-bold tracking-[0.3em] tabular-nums compact:text-base`}
        />
      </div>
      {feedbackRegion}
      <button
        type="submit"
        disabled={isPending || code.trim() === ""}
        className={PRIMARY_BUTTON_CLASS_NAME}
      >
        {isPending ? text.checking : text.signIn}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <button
          type="button"
          onClick={handleResend}
          disabled={isPending || secondsUntilResend > 0}
          className={LINK_BUTTON_CLASS_NAME}
        >
          {secondsUntilResend > 0
            ? text.sendNewCodeIn(secondsUntilResend)
            : text.sendNewCode}
        </button>
        <button
          type="button"
          onClick={handleUseDifferentEmail}
          disabled={isPending}
          className={LINK_BUTTON_CLASS_NAME}
        >
          {text.useDifferentEmail}
        </button>
      </div>
    </form>
  );
}
