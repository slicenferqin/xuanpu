export type ModelProvider = 'claude'

export interface ModelProfile {
  id: string
  name: string
  provider: ModelProvider
  api_key: string | null
  base_url: string | null
  model_id: string | null
  settings_json: string
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface ModelProfileCreate {
  name: string
  provider: ModelProvider
  api_key?: string | null
  base_url?: string | null
  model_id?: string | null
  settings_json?: string
  is_default?: boolean
}

export interface ModelProfileUpdate {
  name?: string
  provider?: ModelProvider
  api_key?: string | null
  base_url?: string | null
  model_id?: string | null
  settings_json?: string
  is_default?: boolean
}
