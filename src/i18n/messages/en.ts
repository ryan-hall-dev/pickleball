// English interface text: the source of truth. `vi.ts` must have exactly the
// same shape (typed as `Messages`), so a missing translation fails typecheck.
// Values are plain strings, or functions where a name or number is inserted.
// Names, social names, session names and links are inserted as entered.

import { hostEn } from "./hostEn";
import { engineErrorsEn, serverMessagesEn } from "./serverEn";

export const en = {
  languageSwitch: {
    label: "Language",
  },
  themeSwitch: {
    darkMode: "Dark mode",
  },
  loading: {
    checkin: "Loading check-in…",
  },
  appName: "Pickleball Social Manager",
  levels: {
    beginner: "Beginner",
    intermediate: "Intermediate",
    advanced: "Advanced",
  },
  genders: {
    male: "Male",
    female: "Female",
  },
  /** Field errors; the input rules use these English values as their messages. */
  validation: {
    firstNameRequired: "Enter your first name",
    lastNameRequired: "Enter your last name",
    levelRequired: "Choose your level",
    genderRequired: "Choose male or female.",
    nameTooLong: (maxLength: number) => `Use at most ${maxLength} characters.`,
    nameHasControlCharacters: "Remove special characters.",
    hostFirstNameRequired: "Enter a first name.",
    hostLastNameRequired: "Enter a last name.",
    hostLevelRequired: "Choose a level.",
    sessionNameRequired: "Enter a session name.",
    wholeMinutes: (min: number, max: number) =>
      `Use a whole number of minutes from ${min} to ${max}.`,
    courtCountRange: (min: number, max: number) =>
      `Use a whole number of courts from ${min} to ${max}.`,
    validEmail: "Enter a valid email address.",
    displayNameRequired: "Enter a display name.",
    socialNameRequired: "Enter the social's name.",
    checkHighlightedFields: "Check the highlighted fields.",
  },
  time: {
    minutesLeft: (minutes: number) => `${minutes} min left`,
    sessionMinutes: (minutes: number) => `${minutes} min session`,
    minutes: (minutes: number) => `${minutes} min`,
    durationUnavailable: "Duration unavailable",
    startTimeUnavailable: "Start time unavailable",
    startedEndUnavailable: (startTime: string) =>
      `Started ${startTime} · end time unavailable`,
    sessionTimeIsUp: "Session time is up",
  },
  checkin: {
    pageTitle: "Check in",
    welcomeHeading: (socialName: string) => `Welcome to ${socialName}`,
    welcomeIntro: "Please enter your details to check in.",
    formLabel: "Check in",
    firstName: "First name",
    lastName: "Last name",
    yourLevel: "Your level",
    gender: "Gender",
    checkIn: "Check in",
    hostApprovesNote:
      "A host approves each check-in before you're added to today's players.",
    sessionCard: {
      notStarted: "Session not started",
      liveNow: "Live now",
      courts: "courts",
      checkedIn: "checked in",
      duration: "duration",
      unavailable: "Unavailable",
    },
    pill: {
      waiting: "Waiting",
      checkedIn: "Checked in",
    },
    waiting: {
      title: "Waiting for the host to approve",
      sent: (sessionName: string) =>
        `Your check-in for ${sessionName} has been sent.`,
      updatesItself: "This page updates by itself every few seconds.",
      whileYouWait: "While you wait",
      keepOpen:
        "Keep this page open, or come back to the same link later. Your request stays here.",
      takingAWhile: "Taking a while? Let a host know you've arrived.",
    },
    approved: {
      title: (firstName: string) => `You're in, ${firstName}`,
      checkedInTo: (sessionName: string) =>
        `You're checked in to ${sessionName}.`,
      whatNext: "What happens next",
      courtWhenTurn: "The hosts put you on a court when it's your turn.",
      stayNear: "Stay near the courts and listen for your name.",
      canClose: "You can close this page.",
    },
    alreadyCheckedIn: {
      title: (sessionName: string) =>
        `You're already checked in to ${sessionName}`,
      nothingMore: (firstName: string) =>
        `Nothing more to do, ${firstName}. Stay near the courts and listen for your name.`,
    },
    rejected: {
      title: "Check-in not approved",
      text: "The host didn't approve this check-in. Please speak to the host.",
    },
    rateLimited: {
      title: "Too many attempts",
      text: "Too many attempts. Wait a few minutes and try again.",
    },
    inactive: {
      title: "This check-in link isn't active",
      text: "Ask a host at the courts for the current QR code.",
    },
    noOpenSession: {
      title: "No social open right now",
      text: "Check back when your host opens the session.",
      checkAgain: "Check again",
    },
    unavailable: {
      title: "Something went wrong",
      text: "We couldn't reach the check-in. Check your connection and try again.",
      noDoubleSend:
        "If you'd already pressed Check in, trying again won't send a second request.",
    },
    roster: {
      findHeading: "Find your name",
      findIntro: "Type at least 2 letters of the name you use on Reclub.",
      searchLabel: "Your name",
      typeMore: "Type at least 2 letters.",
      searching: "Searching…",
      noMatches:
        "No names match. Check the spelling, or tap My name isn't here.",
      resultsLabel: "Matching names",
      inUse: "In use",
      hostNote: (note: string) => `Host note: ${note}`,
      guestOf: (playerName: string) => `Guest of ${playerName}`,
      notHere: "My name isn't here",
      goneNotice:
        "That name is no longer on the list. Find your name again, or speak to the host.",
      keptNotice:
        "The host kept that name on the other phone. Choose your name again, or speak to the host.",
      detailsHeading: (name: string) => `Hi, ${name}`,
      notYou: "Not you? Go back and choose your name.",
      guestIntro: "Tell us your own name.",
      imHere: "I'm here",
      chooseAnother: "Choose another name",
      inUseHeading: "This name is in use",
      inUseText: (name: string) => `${name} is being used on another phone.`,
      thatsMyName: "That's my name",
      hostAskedNote: "The host is asked to move it to this phone.",
      transferWaitingTitle: "Waiting for the host",
      transferWaitingText: (name: string) =>
        `You asked for ${name}. The host will check and move it to this phone.`,
      checkedInTitle: (firstName: string) => `You're in, ${firstName}`,
      checkedInText: (sessionName: string) =>
        `You're checked in to ${sessionName}.`,
      keepOpen:
        "Keep this page open. The host calls you to a court when it's your turn.",
      walkInsClosedTitle: "Walk-ins are closed",
      walkInsClosedText:
        "Only names on today's list can check in now. Please speak to the host.",
    },
    tryAgain: "Try again",
  },
  host: hostEn,
  serverMessages: serverMessagesEn,
  engineErrors: engineErrorsEn,
};

export type Messages = typeof en;
