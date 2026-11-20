import type { SessionErrorCode } from "@/engine/session/errors";

// Messages host server actions send back. The server always writes these
// English values; the browser shows them in the chosen language through
// `translateMessage` (exact match, or a function's pattern). Functions only
// insert their arguments.

export const serverMessagesEn = {
  somethingWentWrong: "Something went wrong. Try again in a moment.",
  /** Made in the browser when a server action can't be reached. */
  offline: "Couldn't reach the server. Check your connection.",
  access: {
    signedOut: "Your session has ended. Sign in again.",
    notAHost: "You're not a host here. Ask your social manager for an invite.",
    notAManager: "Only the social manager can do this.",
  },
  setup: {
    draftNotOpen:
      "This draft is no longer open (it was discarded or started). Reload the page.",
    changedElsewhere:
      "Setup was changed by another host, tab or device. Reload to see the latest — your unsaved changes here will be lost.",
    liveSessionExists:
      "Your social already has a live session. End it before setting up a new one.",
    checkSessionDetails: "Check the session details and try again.",
    savedButListNotRefreshed:
      "Saved, but the list couldn't refresh. Reload the page.",
    nameAlreadyInSession: (firstName: string, lastName: string) =>
      `Someone named ${firstName} ${lastName} is already in this session. Add something to tell them apart, like an initial.`,
    /** Made in the browser while attendance is still saving. */
    waitForAttendance: "Wait for attendance to finish saving, then try again.",
    coHostDraft: (draftName: string) =>
      `A co-host already started “${draftName}”. You're editing it together.`,
  },
  start: {
    reloadSetupAndRetry: "Reload the setup and try again.",
    sessionNotAvailable: "This session is not available. Reload the setup.",
    actionIdUsed: "That action ID was already used. Reload the session.",
    noLongerDraft: "This session is no longer a draft. Reload the setup.",
    changedElsewhere: "Setup changed elsewhere. Reload before starting.",
    chooseDoublesCourt: "Choose at least one doubles court before starting.",
    chooseDuration: "Choose a duration from 1 to 720 minutes.",
    completeDetails:
      "Complete every player's gender and level before starting.",
    playersChangedElsewhere:
      "Setup or players changed elsewhere. Reload before starting.",
    couldNotStart: "Couldn't start the session. Reload and try again.",
    /** Made in the browser: the start call got no answer. */
    unconfirmed:
      "Couldn't confirm whether the session started. Retry with the same action, or reload.",
  },
  live: {
    couldNotRefresh:
      "Couldn't refresh the session. Check your connection and retry.",
    signInToView: "Sign in as a host to view this session.",
    reloadAndRetry: "Reload the session and try again.",
    signInToChange: "Sign in as a host to change this session.",
    checkAction: "Check the action and retry.",
    sessionNotAvailable: "This session is not available.",
    notSimpleSession: "This session cannot use the simple live controls.",
    onlyStartOrFinishUndo: "Only a game start or finish can be undone here.",
    actionIdUsed: "That action ID was already used. Refresh and try again.",
    groupOrPlayerChanged:
      "The group or player changed. Refresh before trying again.",
    updatedByAnotherHost:
      "Updated by another host. Review the refreshed session.",
    couldNotSave:
      "Couldn't save that action. Retry it after checking your connection.",
    /** Made in the browser: no answer in time. */
    couldNotConfirm:
      "Couldn't confirm that action. Retry to check whether it was saved.",
    waitForSave: "Wait for the current save.",
  },
  addPlayer: {
    sessionChanged:
      "The session changed before this was saved. Nobody was added. Check the latest list, then add again.",
    checkDetails: "Check the name, gender and level, then try again.",
    actionIdUsedForOther:
      "That action ID was already used for a different player. Refresh and add again.",
    notLive: "This session is not live, so nobody can be added.",
    couldNotConfirm:
      "Couldn't confirm that the player was added. Retry to check whether it was saved.",
  },
  hosts: {
    emailCannotBeInvited:
      "That email can't be invited here. Use a different email.",
    fixHighlightedFields: "Fix the highlighted fields.",
    alreadyAHost: "That person is already a host.",
    alreadyOnList: "Already on the hosts list.",
    useDifferentEmail: "Use a different email.",
    nowAHost: (displayName: string, email: string) =>
      `${displayName} is now a host. They sign in on the login page with ${email}.`,
    cannotRemoveSelf: "You can't remove yourself.",
    alreadyRemoved: "That host has already been removed.",
    cannotRemoveManager: "Only the operator can remove a social manager.",
    fixHighlightedField: "Fix the highlighted field.",
    socialRenamed: (socialName: string) => `The social is now ${socialName}.`,
  },
};

/**
 * One plain sentence per engine rejection. English shows the engine's own,
 * more detailed message; other languages show these by code.
 */
export const engineErrorsEn: Record<SessionErrorCode, string> = {
  POLICY_ACTION_NOT_ALLOWED: "This session's rules don't allow that action.",
  SESSION_TIME_UP: "Session time is up: no new groups or games.",
  PLAYER_RESERVED: "That player is already called to another court.",
  CALLED_GROUP_EXISTS: "This court already has a called group.",
  UNKNOWN_CALLED_GROUP: "That called group no longer exists. Refresh.",
  SEQ_NOT_INCREASING: "The session changed. Refresh and try again.",
  TIME_WENT_BACKWARDS: "The session clock is out of step. Refresh.",
  MALFORMED_EVENT: "That action wasn't valid. Refresh and try again.",
  SESSION_NOT_STARTED: "The session hasn't started yet.",
  SESSION_ALREADY_STARTED: "The session has already started.",
  SESSION_ENDED: "The session has ended.",
  SESSION_PAUSED: "The session is paused.",
  SESSION_NOT_PAUSED: "The session isn't paused.",
  INVALID_CONFIG: "The session settings aren't valid.",
  DUPLICATE_ID: "That action was already used. Refresh and try again.",
  UNKNOWN_PARTICIPANT: "That player isn't in this session.",
  UNKNOWN_COURT: "That court isn't in this session.",
  UNKNOWN_MATCH: "That game isn't in this session.",
  PLAYER_NOT_PRESENT: "That player isn't here any more.",
  PLAYER_ALREADY_PRESENT: "That player is already here.",
  PLAYER_PLAYING: "That player is on court right now.",
  PLAYER_SKIPPED: "That player is resting.",
  PLAYER_NOT_SKIPPED: "That player isn't resting.",
  PLAYER_LOCKED: "That player is locked to a court.",
  PLAYER_NOT_LOCKED: "That player isn't locked to a court.",
  PLAYER_NOT_IN_MATCH: "That player isn't in this game.",
  COURT_CLOSED: "That court is closed.",
  COURT_NOT_CLOSED: "That court isn't closed.",
  COURT_BUSY: "A game is already on that court.",
  INVALID_TEAMS:
    "Those teams aren't valid: four men, four women, or one man and one woman on each team.",
  MATCH_NOT_ACTIVE: "That game isn't being played any more.",
  MATCHES_IN_PROGRESS: "Finish the games on court first.",
  INVALID_QUEUE_ORDER: "That waiting order isn't valid.",
  UNKNOWN_TARGET: "That action can't be found. Refresh.",
  TARGET_MISMATCH: "That undo doesn't match the action. Refresh.",
  NOT_REVERSIBLE: "That action can't be undone.",
  ALREADY_COMPENSATED: "That action was already undone.",
  UNDO_BLOCKED: "A later action must be undone first.",
  MANUAL_ASSIGNMENTS_OFF: "Manual changes are switched off for this session.",
  COURT_FULL: "That court has no free seats.",
};
