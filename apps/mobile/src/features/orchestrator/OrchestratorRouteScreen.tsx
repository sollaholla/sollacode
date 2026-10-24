import { useMemo } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import {
  buildOrchestratorUrl,
  isSameEnvironmentOrigin,
  LIVE_INSPECTOR_ROUTE_PATH,
  ORCHESTRATOR_ROUTE_PATH,
} from "./orchestratorUrl";

/**
 * The orchestrator, full screen, on the phone.
 *
 * Hosts the web client's `/orchestrator` route rather than reimplementing the
 * voice session natively. The session is WebRTC straight to OpenAI and already
 * exists there, complete with thread routing, the language pin, waking on
 * awaited work and ending by voice; a second native realtime client would be a
 * second thing to keep in step. Running it here puts the microphone and the
 * audio on the phone, which is what makes it usable on a walk with headphones.
 */
export function OrchestratorRouteScreen() {
  return (
    <EnvironmentWebScreen
      routePath={ORCHESTRATOR_ROUTE_PATH}
      query=""
      notConnected="Connect to a Solla Code environment to talk to the orchestrator from here."
    />
  );
}

/**
 * The Live Inspector, full screen: every thread's work as it happens, with the
 * orchestrator a chat button away. `embedded=1` hands closing and opening
 * threads to this native screen rather than the page.
 */
export function LiveInspectorRouteScreen() {
  return (
    <EnvironmentWebScreen
      routePath={LIVE_INSPECTOR_ROUTE_PATH}
      query="embedded=1"
      notConnected="Connect to a Solla Code environment to watch your threads from here."
    />
  );
}

function EnvironmentWebScreen(props: {
  readonly routePath: string;
  readonly query: string;
  readonly notConnected: string;
}) {
  // The first connected environment: on a phone there is one Mac being driven,
  // and making the user pick before they can talk defeats the point.
  const { environments } = useEnvironments();
  const environmentId = environments[0]?.environmentId ?? null;
  const preparedConnection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const source = useMemo(() => {
    const uri = buildOrchestratorUrl(httpBaseUrl, props.routePath, props.query);
    return uri === null ? null : { uri };
  }, [httpBaseUrl, props.query, props.routePath]);

  if (source === null) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Not connected</Text>
        <Text style={styles.emptyBody}>{props.notConnected}</Text>
      </View>
    );
  }

  return (
    <WebView
      source={source}
      style={styles.web}
      // The voice session starts audio without a further gesture once the user
      // taps the orb, and inline playback keeps it out of the fullscreen video
      // player on iOS.
      mediaPlaybackRequiresUserAction={false}
      allowsInlineMediaPlayback
      // WKWebView otherwise prompts for the microphone on every session, on top
      // of the OS prompt the app already asks for. Granting here is safe because
      // the only page this WebView ever loads is the environment's own
      // orchestrator route — `onShouldStartLoadWithRequest` below enforces that.
      mediaCapturePermissionGrantType="grant"
      // Android needs the app-level RECORD_AUDIO permission (declared in
      // app.config.ts) before the WebView may capture at all.
      allowsProtectedMedia
      // Anything leaving the environment's own origin is a link, not the voice
      // UI, and replacing this screen with a web page would strand the user.
      onShouldStartLoadWithRequest={(request) => {
        if (isSameEnvironmentOrigin(request.url, httpBaseUrl)) return true;
        void Linking.openURL(request.url).catch(() => undefined);
        return false;
      }}
      {...(Platform.OS === "android" ? { mixedContentMode: "always" as const } : {})}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "transparent" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: "600" },
  emptyBody: { fontSize: 14, opacity: 0.7, textAlign: "center" },
});
