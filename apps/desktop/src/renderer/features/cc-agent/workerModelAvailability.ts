import { providerOffersModel, type AgentKind, type ProviderView } from '@lizi/model-providers';

import type { AgentCapabilities, ModelDescriptor } from '@/hooks/useAgentCapabilities';

export interface SelectWorkerModelsOptions {
  agent: AgentKind;
  capabilities: AgentCapabilities | null;
  deviceId?: string;
  providers: ProviderView[];
  providersLoading: boolean;
  providersError: string | null;
}

/**
 * Resolve the models that the Worker creation form may submit.
 *
 * Local sessions preserve the existing behavior: capabilities are authoritative and budget
 * Codex models additionally require the local XD provider. Modern device-link peers are stricter:
 * the model must be offered by a connected provider on the controlled device. Older peers that do
 * not implement `maker:provider:list` fall back to that same device's capabilities, never to the
 * controller's provider catalog.
 */
export function selectWorkerModels({
  agent,
  capabilities,
  deviceId,
  providers,
  providersLoading,
  providersError,
}: SelectWorkerModelsOptions): ModelDescriptor[] {
  const models = capabilities?.availableModels ?? [];

  if (!deviceId) {
    if (agent !== 'codex') return models;
    const xdConnected = providers.some((provider) => provider.id === 'xd' && provider.connected);
    return models.filter((model) => xdConnected || !model.id.startsWith('codex/'));
  }

  if (providersError) return models;
  if (providersLoading) return [];

  return models.filter((model) =>
    providers.some(
      (provider) =>
        provider.connected &&
        provider.agents.includes(agent) &&
        providerOffersModel(provider, model.id, agent),
    ),
  );
}
