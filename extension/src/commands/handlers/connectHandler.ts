import { RelayClient } from "../../relay/relayClient";
import type { EncryptionService } from "../../encryption/encryptionService";

export function handleConnect(client: RelayClient, identity: EncryptionService): void {
    client.connect(identity);
}

export default handleConnect;
