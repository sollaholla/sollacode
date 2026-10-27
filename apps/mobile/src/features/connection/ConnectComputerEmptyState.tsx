import { EmptyState } from "../../components/EmptyState";

export function ConnectComputerEmptyState(props: { readonly onConnect: () => void }) {
  return (
    <EmptyState
      title="Connect your computer"
      detail="Open Solla Code on your computer, then go to Settings → Connections → Connect another device. Scan its QR code or paste the connection link here."
      actionLabel="Connect a computer"
      onAction={props.onConnect}
    />
  );
}
