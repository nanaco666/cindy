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
 * Capabilities define what the agent can understand, while the connected provider snapshot defines
 * what it can actually execute. Codex therefore intersects both snapshots locally and remotely.
 * Older device-link peers that do not implement `maker:provider:list` fall back to that same
 * device's capabilities, never to the controller's provider catalog.
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
    return models.filter((model) =>
      providers.some(
        (provider) =>
          provider.connected &&
          provider.agents.includes(agent) &&
          providerOffersModel(provider, model.id, agent),
      ),
    );
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
