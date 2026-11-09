import { RelayClient } from "../../relay/relayClient";

export function handleConnect(client: RelayClient, identity: string): void {
    client.connect(identity);
}

export default handleConnect;
