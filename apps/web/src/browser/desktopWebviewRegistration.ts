export type DesktopWebviewRegistration = (webContentsId: number) => Promise<void> | void;

export interface DesktopWebviewRegistrationOwner {
  readonly request: (webContentsId: number) => void;
  readonly release: () => void;
}

interface PendingRegistration {
  readonly owner: symbol;
  readonly webContentsId: number;
  readonly register: DesktopWebviewRegistration;
}

interface TabRegistrationState {
  owner: symbol | null;
  pending: PendingRegistration | null;
  draining: Promise<void> | null;
}

export interface DesktopWebviewRegistrationCoordinator {
  readonly acquire: (
    tabId: string,
    register: DesktopWebviewRegistration,
  ) => DesktopWebviewRegistrationOwner;
}

export function createDesktopWebviewRegistrationCoordinator(): DesktopWebviewRegistrationCoordinator {
  const states = new Map<string, TabRegistrationState>();

  const deleteIfIdle = (tabId: string, state: TabRegistrationState) => {
    if (state.owner === null && state.pending === null && state.draining === null) {
      states.delete(tabId);
    }
  };

  const drain = (tabId: string, state: TabRegistrationState): void => {
    if (state.draining !== null) return;

    const pendingDrain = (async () => {
      while (true) {
        const registration = state.pending;
        if (registration === null) return;
        state.pending = null;
        if (registration.owner !== state.owner) continue;

        try {
          await registration.register(registration.webContentsId);
        } catch {
          // did-attach/dom-ready will request registration again if the main
          // process or guest was not ready yet.
        }
      }
    })();

    state.draining = pendingDrain;
    const finishDrain = () => {
      if (state.draining !== pendingDrain) return;
      state.draining = null;
      if (state.pending !== null) {
        drain(tabId, state);
      } else {
        deleteIfIdle(tabId, state);
      }
    };
    void pendingDrain.then(finishDrain, finishDrain);
  };

  return {
    acquire: (tabId, register) => {
      const state =
        states.get(tabId) ??
        ({ owner: null, pending: null, draining: null } satisfies TabRegistrationState);
      const owner = Symbol(tabId);
      state.owner = owner;
      state.pending = null;
      states.set(tabId, state);

      return {
        request: (webContentsId) => {
          if (state.owner !== owner || states.get(tabId) !== state) return;
          state.pending = { owner, webContentsId, register };
          drain(tabId, state);
        },
        release: () => {
          if (state.owner !== owner || states.get(tabId) !== state) return;
          state.owner = null;
          state.pending = null;
          deleteIfIdle(tabId, state);
        },
      };
    },
  };
}

const desktopWebviewRegistrationCoordinator = createDesktopWebviewRegistrationCoordinator();

export const acquireDesktopWebviewRegistrationOwner = (
  tabId: string,
  register: DesktopWebviewRegistration,
): DesktopWebviewRegistrationOwner =>
  desktopWebviewRegistrationCoordinator.acquire(tabId, register);
