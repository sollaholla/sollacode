import { WELCOME_TOUR_VERSION } from "@t3tools/contracts";
import { useState } from "react";

import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { withFirstRunTransition } from "./firstRunTransition";
import { StartupPreferences } from "./StartupPreferences";
import { WelcomeTour } from "./WelcomeTour";
import {
  readWelcomeProgress,
  saveWelcomeProgress,
  type WelcomeProgress,
} from "./welcomeTour.logic";

/**
 * After provider setup: preferences, then the tour. Where someone stopped is kept
 * on this device, and finishing or skipping is saved on the computer running Solla
 * Code, so it does not open again on any device.
 */
export function WelcomeFlow({ onDone }: { readonly onDone: () => void }) {
  const updateSettings = useUpdatePrimarySettings();
  const [progress, setProgress] = useState<WelcomeProgress>(readWelcomeProgress);

  const finish = () => {
    saveWelcomeProgress(null);
    updateSettings({ welcomeTourVersion: WELCOME_TOUR_VERSION });
    withFirstRunTransition(onDone);
  };
  const show = (next: WelcomeProgress) => {
    saveWelcomeProgress(next);
    withFirstRunTransition(() => setProgress(next));
  };

  if (progress.screen === "preferences") {
    return (
      <StartupPreferences onSkip={finish} onContinue={() => show({ screen: "tour", step: 0 })} />
    );
  }
  return (
    <WelcomeTour
      initialStep={progress.step}
      doneLabel="Get started"
      onStepChange={(step) => saveWelcomeProgress({ screen: "tour", step })}
      onDone={finish}
      onBackFromStart={() => show({ screen: "preferences" })}
    />
  );
}
