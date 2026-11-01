export const START_PICK_CHANNEL = "preview:start-pick";
export const CANCEL_PICK_CHANNEL = "preview:cancel-pick";
export const ELEMENT_PICKED_CHANNEL = "preview:element-picked";
export const ANNOTATION_CAPTURED_CHANNEL = "preview:annotation-captured";
export const ANNOTATION_THEME_CHANNEL = "preview:annotation-theme";
export const HUMAN_INPUT_CHANNEL = "preview:human-input";

export const VIDEO_SOURCE_CHANGED_CHANNEL = "preview:video-source-changed";

/** The name typed on a sign-in page, sent ahead because the password is often on the next page. */
export const SIGN_IN_USERNAME_CHANNEL = "preview:sign-in-username";
/** A person submitted a password. Held in the desktop process only, never passed on. */
export const SIGN_IN_ATTEMPT_CHANNEL = "preview:sign-in-attempt";
/** Whether the current page asks for a password, which is how a sign-in is seen to have worked. */
export const SIGN_IN_PAGE_CHANNEL = "preview:sign-in-page";

export interface SignInUsernameSignal {
  readonly origin: string;
  readonly username: string;
}

export interface SignInAttemptSignal {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
}

export interface SignInPageSignal {
  readonly origin: string;
  readonly hasPasswordField: boolean;
}
