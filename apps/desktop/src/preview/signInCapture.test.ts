// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installSignInCapture, type SignInCaptureSink } from "./signInCapture.ts";

/** happy-dom cannot mint a trusted event, so the flag is set the way a real one reads. */
function fire(target: EventTarget, event: Event, trusted = true): void {
  Object.defineProperty(event, "isTrusted", { value: trusted });
  target.dispatchEvent(event);
}

function setup(html: string, secure = true) {
  document.body.innerHTML = html;
  const sink = {
    username: vi.fn<SignInCaptureSink["username"]>(),
    attempt: vi.fn<SignInCaptureSink["attempt"]>(),
    page: vi.fn<SignInCaptureSink["page"]>(),
  };
  installSignInCapture({
    document,
    origin: () => "https://app.example.com",
    isSecure: () => secure,
    sink,
  });
  return sink;
}

const type = (selector: string, value: string, trusted = true) => {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no ${selector}`);
  input.value = value;
  fire(input, new Event("input", { bubbles: true }), trusted);
  return input;
};

const FORM = `<form><input type="email" id="name"><input type="password" id="pass"><button id="go">Go</button></form>`;

describe("installSignInCapture", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reports nothing until the person submits", () => {
    const sink = setup(FORM);
    type("#name", "me@example.com");
    type("#pass", "hunter2");
    expect(sink.attempt).not.toHaveBeenCalled();
    expect(sink.username).not.toHaveBeenCalled();
  });

  it("reports the name and password on Enter", () => {
    const sink = setup(FORM);
    type("#name", "me@example.com");
    const pass = type("#pass", "hunter2");
    fire(pass, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sink.attempt).toHaveBeenCalledWith({
      origin: "https://app.example.com",
      username: "me@example.com",
      password: "hunter2",
    });
  });

  it("reports on a click of a button", () => {
    const sink = setup(FORM);
    type("#pass", "hunter2");
    fire(document.getElementById("go") as HTMLElement, new MouseEvent("click", { bubbles: true }));
    expect(sink.attempt).toHaveBeenCalledTimes(1);
  });

  it("sends the name ahead when the password is on the next page", () => {
    const sink = setup(`<input type="email" id="name"><button id="go">Next</button>`);
    type("#name", "me@example.com");
    fire(document.getElementById("go") as HTMLElement, new MouseEvent("click", { bubbles: true }));
    expect(sink.username).toHaveBeenCalledWith({
      origin: "https://app.example.com",
      username: "me@example.com",
    });
    expect(sink.attempt).not.toHaveBeenCalled();
  });

  it("does not count a script's typing or a script's click", () => {
    const sink = setup(FORM);
    type("#pass", "scripted", false);
    fire(document.getElementById("go") as HTMLElement, new MouseEvent("click", { bubbles: true }));
    expect(sink.attempt).not.toHaveBeenCalled();

    type("#pass", "hunter2");
    fire(
      document.getElementById("go") as HTMLElement,
      new MouseEvent("click", { bubbles: true }),
      false,
    );
    expect(sink.attempt).not.toHaveBeenCalled();
  });

  it("reports only one attempt for one password", () => {
    const sink = setup(FORM);
    const pass = type("#pass", "hunter2");
    fire(pass, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    fire(document.getElementById("go") as HTMLElement, new MouseEvent("click", { bubbles: true }));
    expect(sink.attempt).toHaveBeenCalledTimes(1);
  });

  it("ignores a page that is not secure", () => {
    const sink = setup(FORM, false);
    const pass = type("#pass", "hunter2");
    fire(pass, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sink.attempt).not.toHaveBeenCalled();
    expect(sink.username).not.toHaveBeenCalled();
  });
});
