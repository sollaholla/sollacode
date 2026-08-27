import {
  createPathConfigForStaticNavigation,
  getPathFromState,
  NavigationState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  createNativeStackScreen,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { type ComponentType, useEffect, useRef } from "react";
import { DynamicColorIOS, Platform, Pressable, ScrollView, StyleSheet } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "./components/AppText";
import { AdaptiveWorkspaceLayout } from "./features/layout/AdaptiveWorkspaceLayout";
import { HardwareKeyboardCommandProvider } from "./features/keyboard/HardwareKeyboardCommandProvider";
import { HomeRouteScreen } from "./features/home/HomeRouteScreen";
import { useAppShortcuts } from "./features/shortcuts/useAppShortcuts";
import { useIncomingShare } from "./features/sharing/IncomingShareProvider";
import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  transitionIncomingSharePresentation,
} from "./features/sharing/incoming-share-presentation";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native/native-glass";
import { nativeHeaderScrollEdgeEffects } from "./native/StackHeader";
import { useThreadOutboxDrain } from "./state/use-thread-outbox-drain";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

function deferredScreen<TProps extends object>(
  load: () => ComponentType<TProps>,
): ComponentType<TProps> {
  let LoadedScreen: ComponentType<TProps> | undefined;

  return function DeferredScreen(props: TProps) {
    LoadedScreen ??= load();
    return <LoadedScreen {...props} />;
  };
}

function ShowcaseCaptureCoordinator(props: { readonly pathname: string }) {
  if (!SHOWCASE_ENABLED) {
    return null;
  }
  const Coordinator = (
    require("./features/showcase/ShowcaseCaptureCoordinator") as typeof import("./features/showcase/ShowcaseCaptureCoordinator")
  ).ShowcaseCaptureCoordinator;
  return <Coordinator {...props} />;
}

const ArchivedThreadsRouteScreen = deferredScreen(
  () =>
    (
      require("./features/archive/ArchivedThreadsRouteScreen") as typeof import("./features/archive/ArchivedThreadsRouteScreen")
    ).ArchivedThreadsRouteScreen,
);
const ThreadFilesTreeScreen = deferredScreen(
  () =>
    (
      require("./features/files/ThreadFilesRouteScreen") as typeof import("./features/files/ThreadFilesRouteScreen")
    ).ThreadFilesTreeScreen,
);
const ThreadFileScreen = deferredScreen(
  () =>
    (
      require("./features/files/ThreadFilesRouteScreen") as typeof import("./features/files/ThreadFilesRouteScreen")
    ).ThreadFileScreen,
);
const ReviewCommentComposerSheet = deferredScreen(
  () =>
    (
      require("./features/review/ReviewCommentComposerSheet") as typeof import("./features/review/ReviewCommentComposerSheet")
    ).ReviewCommentComposerSheet,
);
const ReviewSheet = deferredScreen(
  () =>
    (require("./features/review/ReviewSheet") as typeof import("./features/review/ReviewSheet"))
      .ReviewSheet,
);
const ThreadTerminalRouteScreen = deferredScreen(
  () =>
    (
      require("./features/terminal/ThreadTerminalRouteScreen") as typeof import("./features/terminal/ThreadTerminalRouteScreen")
    ).ThreadTerminalRouteScreen,
);
const GitBranchesSheet = deferredScreen(
  () =>
    (
      require("./features/threads/git/GitBranchesSheet") as typeof import("./features/threads/git/GitBranchesSheet")
    ).GitBranchesSheet,
);
const GitCommitSheet = deferredScreen(
  () =>
    (
      require("./features/threads/git/GitCommitSheet") as typeof import("./features/threads/git/GitCommitSheet")
    ).GitCommitSheet,
);
const GitConfirmSheet = deferredScreen(
  () =>
    (
      require("./features/threads/git/GitConfirmSheet") as typeof import("./features/threads/git/GitConfirmSheet")
    ).GitConfirmSheet,
);
const GitOverviewSheet = deferredScreen(
  () =>
    (
      require("./features/threads/git/GitOverviewSheet") as typeof import("./features/threads/git/GitOverviewSheet")
    ).GitOverviewSheet,
);
const ThreadRouteScreen = deferredScreen(
  () =>
    (
      require("./features/threads/ThreadRouteScreen") as typeof import("./features/threads/ThreadRouteScreen")
    ).ThreadRouteScreen,
);
const ConnectionsRouteScreen = deferredScreen(
  () =>
    (
      require("./features/connection/ConnectionsRouteScreen") as typeof import("./features/connection/ConnectionsRouteScreen")
    ).ConnectionsRouteScreen,
);
const ConnectionsNewRouteScreen = deferredScreen(
  () =>
    (
      require("./features/connection/ConnectionsNewRouteScreen") as typeof import("./features/connection/ConnectionsNewRouteScreen")
    ).ConnectionsNewRouteScreen,
);
const OrchestratorRouteScreen = deferredScreen(
  () =>
    (
      require("./features/orchestrator/OrchestratorRouteScreen") as typeof import("./features/orchestrator/OrchestratorRouteScreen")
    ).OrchestratorRouteScreen,
);
const AgentsRouteScreen = deferredScreen(
  () =>
    (
      require("./features/agents/AgentRouteScreens") as typeof import("./features/agents/AgentRouteScreens")
    ).AgentsRouteScreen,
);
const AgentRouteScreen = deferredScreen(
  () =>
    (
      require("./features/agents/AgentRouteScreens") as typeof import("./features/agents/AgentRouteScreens")
    ).AgentRouteScreen,
);
const AgentRulesRouteScreen = deferredScreen(
  () =>
    (
      require("./features/agents/AgentRouteScreens") as typeof import("./features/agents/AgentRouteScreens")
    ).AgentRulesRouteScreen,
);
const ThreadArtifactsRouteScreen = deferredScreen(
  () =>
    (
      require("./features/artifacts/ThreadArtifactRouteScreens") as typeof import("./features/artifacts/ThreadArtifactRouteScreens")
    ).ThreadArtifactsRouteScreen,
);
const ThreadArtifactRouteScreen = deferredScreen(
  () =>
    (
      require("./features/artifacts/ThreadArtifactRouteScreens") as typeof import("./features/artifacts/ThreadArtifactRouteScreens")
    ).ThreadArtifactRouteScreen,
);
const ThreadBrowserRouteScreen = deferredScreen(
  () =>
    (
      require("./features/preview/ThreadBrowserRouteScreen") as typeof import("./features/preview/ThreadBrowserRouteScreen")
    ).ThreadBrowserRouteScreen,
);
const AddProjectDestinationRoute = deferredScreen(
  () =>
    (
      require("./features/projects/AddProjectDestinationRoute") as typeof import("./features/projects/AddProjectDestinationRoute")
    ).AddProjectDestinationRoute,
);
const AddProjectLocalRoute = deferredScreen(
  () =>
    (
      require("./features/projects/AddProjectLocalRoute") as typeof import("./features/projects/AddProjectLocalRoute")
    ).AddProjectLocalRoute,
);
const AddProjectRepositoryRoute = deferredScreen(
  () =>
    (
      require("./features/projects/AddProjectRepositoryRoute") as typeof import("./features/projects/AddProjectRepositoryRoute")
    ).AddProjectRepositoryRoute,
);
const AddProjectSourceRoute = deferredScreen(
  () =>
    (
      require("./features/projects/AddProjectSourceRoute") as typeof import("./features/projects/AddProjectSourceRoute")
    ).AddProjectSourceRoute,
);
const NewTaskDraftRouteScreen = deferredScreen(
  () =>
    (
      require("./features/threads/NewTaskDraftRouteScreen") as typeof import("./features/threads/NewTaskDraftRouteScreen")
    ).NewTaskDraftRouteScreen,
);
const NewTaskRouteScreen = deferredScreen(
  () =>
    (
      require("./features/threads/NewTaskRouteScreen") as typeof import("./features/threads/NewTaskRouteScreen")
    ).NewTaskRouteScreen,
);
const SettingsAppearanceRouteScreen = deferredScreen(
  () =>
    (
      require("./features/settings/SettingsAppearanceRouteScreen") as typeof import("./features/settings/SettingsAppearanceRouteScreen")
    ).SettingsAppearanceRouteScreen,
);
const SettingsClientStorageRouteScreen = deferredScreen(
  () =>
    (
      require("./features/settings/SettingsClientStorageRouteScreen") as typeof import("./features/settings/SettingsClientStorageRouteScreen")
    ).SettingsClientStorageRouteScreen,
);
const SettingsEnvironmentsRouteScreen = deferredScreen(
  () =>
    (
      require("./features/settings/SettingsEnvironmentsRouteScreen") as typeof import("./features/settings/SettingsEnvironmentsRouteScreen")
    ).SettingsEnvironmentsRouteScreen,
);
const SettingsLegalRouteScreen = deferredScreen(
  () =>
    (
      require("./features/settings/SettingsLegalRouteScreen") as typeof import("./features/settings/SettingsLegalRouteScreen")
    ).SettingsLegalRouteScreen,
);
const SettingsRouteScreen = deferredScreen(
  () =>
    (
      require("./features/settings/SettingsRouteScreen") as typeof import("./features/settings/SettingsRouteScreen")
    ).SettingsRouteScreen,
);

function NewTaskFlowProvider(props: { readonly children: React.ReactNode }) {
  const Provider = (
    require("./features/threads/new-task-flow-provider") as typeof import("./features/threads/new-task-flow-provider")
  ).NewTaskFlowProvider;
  return <Provider>{props.children}</Provider>;
}

function SettingsLegalDocumentCloseHeaderButton() {
  const HeaderButton = (
    require("./features/settings/components/SettingsLegalDocumentRouteScreen") as typeof import("./features/settings/components/SettingsLegalDocumentRouteScreen")
  ).SettingsLegalDocumentCloseHeaderButton;
  return <HeaderButton />;
}

function SettingsLegalDocumentExternalHeaderButton() {
  const HeaderButton = (
    require("./features/settings/components/SettingsLegalDocumentRouteScreen") as typeof import("./features/settings/components/SettingsLegalDocumentRouteScreen")
  ).SettingsLegalDocumentExternalHeaderButton;
  return <HeaderButton />;
}

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

// Matches --color-sheet in global.css (light/dark). DynamicColorIOS lets the header
// background stay STATIC config while still adapting to appearance changes.
const SHEET_BACKGROUND_COLOR =
  Platform.OS === "ios"
    ? DynamicColorIOS({ light: "rgba(242, 242, 247, 0.98)", dark: "rgba(14, 14, 14, 0.98)" })
    : undefined;

type AppScreenOptions = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor";
};

// Shared header presets. Screens only override genuinely dynamic values (titles,
// subtitles, toolbar items, search callbacks) via NativeStackScreenOptions.
//
// GLASS: transparent header over the screen's primary scroll view on supported
// iOS versions. Pre-glass iOS gets the same solid material as internal-scroll
// surfaces so content is laid out below the bar instead of underlapping it.
const GLASS_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED
    ? { backgroundColor: "transparent" }
    : SHEET_BACKGROUND_COLOR !== undefined
      ? { backgroundColor: SHEET_BACKGROUND_COLOR as unknown as string }
      : undefined,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED ? HEADER_SCROLL_EDGE_EFFECTS : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
};

// SOLID: opaque sheet-colored header for surfaces whose content scrolls internally
// (file viewer, terminal, review) — there is nothing for glass to sample there.
const SOLID_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle:
    SHEET_BACKGROUND_COLOR !== undefined
      ? // native-stack types this as `string`, but the native side accepts any
        // ColorValue including DynamicColorIOS.
        { backgroundColor: SHEET_BACKGROUND_COLOR as unknown as string }
      : undefined,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: false,
  unstable_navigationItemStyle: Platform.OS === "ios" ? "editor" : undefined,
};

// Solid header variant for screens inside sheets (centered title, no editor style).
const SHEET_SOLID_HEADER_OPTIONS: AppScreenOptions = {
  ...SOLID_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
};

const LEGAL_DOCUMENT_HEADER_OPTIONS: AppScreenOptions = {
  ...SHEET_SOLID_HEADER_OPTIONS,
  headerBackVisible: false,
  headerLeft: SettingsLegalDocumentCloseHeaderButton,
  headerRight: () => <SettingsLegalDocumentExternalHeaderButton />,
  presentation: "fullScreenModal",
};

const SettingsSheetStack = createNativeStackNavigator({
  initialRouteName: "Settings",
  screenOptions: {
    ...GLASS_HEADER_OPTIONS,
    // Sheets read better with the iOS-default centered title (no editor style).
    unstable_navigationItemStyle: undefined,
  },
  screens: {
    Settings: createNativeStackScreen({
      screen: SettingsRouteScreen,
      linking: "",
      options: {
        title: "Settings",
      },
    }),
    SettingsEnvironments: createNativeStackScreen({
      screen: SettingsEnvironmentsRouteScreen,
      linking: "environments",
      options: {
        title: "Environments",
      },
    }),
    SettingsEnvironmentNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      linking: "environment-new",
      options: {
        title: "Add Environment",
      },
    }),
    SettingsArchive: createNativeStackScreen({
      screen: ArchivedThreadsRouteScreen,
      linking: "archive",
      options: {
        title: "Archived Threads",
      },
    }),
    SettingsAppearance: createNativeStackScreen({
      screen: SettingsAppearanceRouteScreen,
      linking: "appearance",
      options: {
        title: "Appearance",
      },
    }),
    SettingsClientStorage: createNativeStackScreen({
      screen: SettingsClientStorageRouteScreen,
      linking: "client-storage",
      options: {
        title: "Client Storage",
      },
    }),
  },
});

// Thread routes live FLAT in the root stack (not in a nested navigator). A nested
// stack means a second UINavigationController with its own UINavigationBar, which
// breaks iOS 26's shared-header morphing between Home and Thread (each pair inside
// one bar morphs; across two bars the whole screen slides). Flat linking paths keep
// the same deep-link URLs the nested config produced.
const THREAD_LINKING_PREFIX = "threads/:environmentId/:threadId";

// New-task / add-project flow: nested navigator inside the formSheet (Settings-sheet
// pattern — a plain formSheet screen cannot render a stack header; the header and
// in-sheet pushes come from this nested stack).
const NewTaskSheetStack = createNativeStackNavigator({
  initialRouteName: "NewTask",
  screenOptions: {
    ...GLASS_HEADER_OPTIONS,
    // Sheets read better with the iOS-default centered title (no editor style).
    unstable_navigationItemStyle: undefined,
  },
  screens: {
    NewTask: createNativeStackScreen({
      screen: NewTaskRouteScreen,
      linking: "",
      options: {
        title: "Choose project",
      },
    }),
    NewTaskDraft: createNativeStackScreen({
      screen: NewTaskDraftRouteScreen,
      linking: "draft",
      // The draft composer has no scroll view for glass to sample; a solid
      // header also lays the content out below the bar (no manual inset).
      options: SHEET_SOLID_HEADER_OPTIONS,
    }),
    AddProject: createNativeStackScreen({
      screen: AddProjectSourceRoute,
      linking: "add-project",
      options: {
        title: "Add Project",
      },
    }),
    AddProjectRepository: createNativeStackScreen({
      screen: AddProjectRepositoryRoute,
      linking: "add-project/repository",
    }),
    AddProjectDestination: createNativeStackScreen({
      screen: AddProjectDestinationRoute,
      linking: "add-project/destination",
    }),
    AddProjectLocal: createNativeStackScreen({
      screen: AddProjectLocalRoute,
      linking: "add-project/local",
    }),
  },
});

// Routes presented as sheets/overlays ON TOP of the workspace. They must not
// influence the adaptive workspace layout: opening Settings over Home should
// not flip the sidebar in or change the active thread.
const WORKSPACE_OVERLAY_ROUTES = new Set([
  "Connections",
  "ConnectionsNew",
  "GitBranches",
  "GitCommit",
  "GitConfirm",
  "GitOverview",
  "NewTaskSheet",
  "Orchestrator",
  "SettingsLegal",
  "SettingsSheet",
  "ThreadReviewComment",
]);

/**
 * Pathname of the topmost NON-overlay route — the screen the workspace is
 * actually "on", regardless of any sheets floating above it.
 */
function workspacePathFromState(state: NavigationState): string {
  const routes = state.routes.filter((route) => !WORKSPACE_OVERLAY_ROUTES.has(route.name));
  const effectiveState =
    routes.length > 0 && routes.length !== state.routes.length
      ? ({ ...state, routes, index: routes.length - 1 } as NavigationState)
      : state;
  const path = getPathFromState(effectiveState, navigationPathConfig);
  return path.startsWith("/") ? path : `/${path}`;
}

function RootStackLayout(props: {
  readonly children: React.ReactNode;
  readonly state: NavigationState;
}) {
  const navigation = useNavigation();
  const { pendingShare } = useIncomingShare();
  const sharePresentationRef = useRef(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);
  useThreadOutboxDrain();
  // Launcher app shortcuts: routes shortcut taps and tracks opened threads.
  useAppShortcuts(props.state);
  useEffect(() => {
    const topRouteName = props.state.routes[props.state.index]?.name;
    const transition = transitionIncomingSharePresentation(sharePresentationRef.current, {
      isShareSheetPresented: topRouteName === "NewTaskSheet",
      pendingShareId: pendingShare?.id ?? null,
    });
    sharePresentationRef.current = transition.state;
    if (!transition.shareIdToPresent) {
      return;
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTask",
      params: { incomingShareId: transition.shareIdToPresent },
    });
  }, [navigation, pendingShare, props.state]);
  // Full pathname (sheets included) for keyboard-command scoping; the
  // workspace layout only reacts to the underlying non-overlay route.
  const path = getPathFromState(props.state, navigationPathConfig);
  const pathname = path.startsWith("/") ? path : `/${path}`;
  const workspacePathname = workspacePathFromState(props.state);

  return (
    <HardwareKeyboardCommandProvider pathname={pathname}>
      <ShowcaseCaptureCoordinator pathname={pathname} />
      <AdaptiveWorkspaceLayout pathname={workspacePathname}>
        {props.children}
      </AdaptiveWorkspaceLayout>
    </HardwareKeyboardCommandProvider>
  );
}

function NotFoundScreen() {
  const navigation = useNavigation();
  const screenBgStyle = StyleSheet.flatten(useResolveClassNames("bg-screen"));
  const primaryBgStyle = StyleSheet.flatten(useResolveClassNames("bg-primary"));
  const returnHomeButtonStyle = StyleSheet.flatten([
    {
      borderRadius: 999,
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    primaryBgStyle,
  ]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      style={[{ flex: 1 }, screenBgStyle]}
    >
      <Text className="text-3xl font-t3-bold text-foreground" selectable>
        Route not found
      </Text>
      <Pressable
        style={returnHomeButtonStyle}
        onPress={() => navigation.dispatch(StackActions.replace("Home"))}
      >
        <Text className="text-base font-t3-bold text-primary-foreground">Return home</Text>
      </Pressable>
    </ScrollView>
  );
}

export const RootStack = createNativeStackNavigator({
  initialRouteName: "Home",
  layout: RootStackLayout,
  screenOptions: {
    headerShown: false,
  },
  screens: {
    Home: createNativeStackScreen({
      screen: HomeRouteScreen,
      linking: "",
      options: {
        ...GLASS_HEADER_OPTIONS,
        contentStyle: { backgroundColor: "transparent" },
        headerBackVisible: false,
        title: "Threads",
      },
    }),
    Thread: createNativeStackScreen({
      screen: ThreadRouteScreen,
      linking: THREAD_LINKING_PREFIX,
      options: GLASS_HEADER_OPTIONS,
    }),
    ThreadTerminal: createNativeStackScreen({
      screen: ThreadTerminalRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/terminal`,
      options: SOLID_HEADER_OPTIONS,
    }),
    ThreadReview: createNativeStackScreen({
      screen: ReviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/review`,
      options: SOLID_HEADER_OPTIONS,
    }),
    ThreadReviewComment: createNativeStackScreen({
      screen: ReviewCommentComposerSheet,
      linking: `${THREAD_LINKING_PREFIX}/review-comment`,
      options: {
        // Android cannot host the keyboard-driven comment composer inside a
        // formSheet; use a full-screen modal there instead.
        presentation: Platform.OS === "android" ? "fullScreenModal" : "formSheet",
        sheetAllowedDetents: Platform.OS === "android" ? undefined : [0.55, 0.92],
        sheetGrabberVisible: Platform.OS !== "android",
      },
    }),
    ThreadFiles: createNativeStackScreen({
      screen: ThreadFilesTreeScreen,
      linking: `${THREAD_LINKING_PREFIX}/files`,
      options: {
        ...GLASS_HEADER_OPTIONS,
        contentStyle:
          SHEET_BACKGROUND_COLOR !== undefined
            ? { backgroundColor: SHEET_BACKGROUND_COLOR }
            : undefined,
        title: "Files",
      },
    }),
    ThreadFile: createNativeStackScreen({
      screen: ThreadFileScreen,
      linking: `${THREAD_LINKING_PREFIX}/files/:path*`,
      options: SOLID_HEADER_OPTIONS,
    }),
    ThreadArtifacts: createNativeStackScreen({
      screen: ThreadArtifactsRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/artifacts`,
      options: {
        ...GLASS_HEADER_OPTIONS,
        title: "Artifacts",
      },
    }),
    ThreadArtifact: createNativeStackScreen({
      screen: ThreadArtifactRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/artifacts/:artifactId`,
      options: {
        ...SOLID_HEADER_OPTIONS,
        title: "Artifact",
      },
    }),
    ThreadBrowser: createNativeStackScreen({
      screen: ThreadBrowserRouteScreen,
      linking: `${THREAD_LINKING_PREFIX}/browser`,
      options: {
        ...GLASS_HEADER_OPTIONS,
        title: "Browser",
      },
    }),
    GitOverview: createNativeStackScreen({
      screen: GitOverviewSheet,
      linking: `${THREAD_LINKING_PREFIX}/git`,
      options: {
        presentation: "formSheet",
        sheetAllowedDetents: [0.55, 0.92],
        sheetGrabberVisible: true,
      },
    }),
    GitCommit: createNativeStackScreen({
      screen: GitCommitSheet,
      linking: `${THREAD_LINKING_PREFIX}/git/commit`,
      options: {
        presentation: "formSheet",
        sheetAllowedDetents: [0.55, 0.92],
        sheetGrabberVisible: true,
      },
    }),
    GitBranches: createNativeStackScreen({
      screen: GitBranchesSheet,
      linking: `${THREAD_LINKING_PREFIX}/git/branches`,
      options: {
        presentation: "formSheet",
        sheetAllowedDetents: [0.55, 0.92],
        sheetGrabberVisible: true,
      },
    }),
    GitConfirm: createNativeStackScreen({
      screen: GitConfirmSheet,
      linking: `${THREAD_LINKING_PREFIX}/git-confirm`,
      options: {
        presentation: "formSheet",
        sheetAllowedDetents: [0.45, 0.7],
        sheetGrabberVisible: true,
      },
    }),
    // Full screen, and at the root rather than inside the Settings sheet: this
    // is summoned by a double press of volume up with the phone in a pocket, and
    // a detented sheet over the thread list is not what someone wearing
    // headphones needs to land in.
    Orchestrator: createNativeStackScreen({
      screen: OrchestratorRouteScreen,
      linking: "orchestrator",
      options: {
        ...SOLID_HEADER_OPTIONS,
        presentation: "fullScreenModal",
        title: "Orchestrator",
      },
    }),
    Agents: createNativeStackScreen({
      screen: AgentsRouteScreen,
      linking: "agents",
      options: {
        ...GLASS_HEADER_OPTIONS,
        title: "Agents",
      },
    }),
    Agent: createNativeStackScreen({
      screen: AgentRouteScreen,
      linking: "agents/:environmentId/:agentId",
      options: {
        ...GLASS_HEADER_OPTIONS,
        title: "Agent",
      },
    }),
    AgentRules: createNativeStackScreen({
      screen: AgentRulesRouteScreen,
      linking: "agents/:environmentId/:agentId/rules",
      options: {
        ...GLASS_HEADER_OPTIONS,
        title: "Rules",
      },
    }),
    SettingsSheet: createNativeStackScreen({
      screen: SettingsSheetStack,
      linking: "settings",
      options: {
        gestureEnabled: true,
        headerShown: false,
        // Android pushes settings as a regular full page with an in-screen
        // back header; iOS keeps the detented form sheet.
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : {
              presentation: "formSheet" as const,
              sheetAllowedDetents: [0.7, 0.92],
              sheetGrabberVisible: true,
            }),
      },
    }),
    SettingsLegal: createNativeStackScreen({
      screen: SettingsLegalRouteScreen,
      linking: "settings/legal",
      options: {
        ...LEGAL_DOCUMENT_HEADER_OPTIONS,
        title: "Legal",
      },
    }),
    Connections: createNativeStackScreen({
      screen: ConnectionsRouteScreen,
      linking: "connections",
      options: {
        title: "Environments",
        // Android: full page; the screen renders its own AndroidScreenHeader,
        // so the native bar stays hidden. iOS keeps the sheet.
        ...(Platform.OS === "android"
          ? { presentation: "card" as const, headerShown: false }
          : {
              presentation: "formSheet" as const,
              sheetAllowedDetents: [0.55, 0.7],
              sheetGrabberVisible: true,
            }),
      },
    }),
    ConnectionsNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      linking: "connections/new",
      options: {
        presentation: "formSheet",
        sheetAllowedDetents: [0.55, 0.7],
        sheetGrabberVisible: true,
      },
    }),
    NewTaskSheet: createNativeStackScreen({
      screen: NewTaskSheetStack,
      linking: "new",
      // The whole new-task flow (choose project → draft → add project) shares
      // draft state via NewTaskFlowProvider. The expo-router era mounted it in
      // app/new/_layout.tsx; this layout wrapper is the native-stack equivalent.
      layout: ({ children }) => <NewTaskFlowProvider>{children}</NewTaskFlowProvider>,
      options: {
        gestureEnabled: true,
        headerShown: false,
        // Android pushes the flow as a regular full page — the draft should
        // read like a thread that just doesn't exist yet; iOS keeps the sheet.
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : {
              presentation: "formSheet" as const,
              sheetAllowedDetents: [0.92],
              sheetGrabberVisible: true,
            }),
      },
    }),
    NotFound: createNativeStackScreen({
      screen: NotFoundScreen,
      linking: "*",
    }),
  },
});
type RootStackType = typeof RootStack;

const navigationPathConfig = {
  screens: createPathConfigForStaticNavigation(RootStack) ?? {},
};

declare module "@react-navigation/native" {
  interface RootNavigator extends RootStackType {}
}
