import type { ReactNode } from "react";

export function ComposerStatusRail(props: {
  readonly voice?: ReactNode;
  readonly usage?: ReactNode;
  readonly actions?: ReactNode;
}) {
  if (!props.voice && !props.usage && !props.actions) return null;

  return (
    <div
      className="chat-composer-status-container chat-composer-measure pointer-events-none relative z-20"
      data-chat-composer-status-container="true"
    >
      <div className="chat-composer-status-rail" data-chat-composer-status-rail="true">
        <div className="chat-composer-status-voice" data-chat-composer-status-slot="voice">
          {props.voice}
        </div>
        <div className="chat-composer-status-usage" data-chat-composer-status-slot="usage">
          {props.usage}
        </div>
        <div className="chat-composer-status-actions" data-chat-composer-status-slot="actions">
          {props.actions}
        </div>
      </div>
    </div>
  );
}
