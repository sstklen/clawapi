// 設定頁面
// 管理引擎全域設定

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';

/** 設定頁面屬性 */
export interface SettingsPageProps {
  settings: {
    server: {
      port: number;
      host: string;
    };
    l0: {
      enabled: boolean;
      ollama_auto_detect: boolean;
      ollama_url: string;
    };
    aid: {
      enabled: boolean;
    };
    telemetry: {
      enabled: boolean;
    };
    routing: {
      default_strategy?: 'fast' | 'smart' | 'cheap';
      default_layer?: string;
    };
    advanced: {
      max_keys_per_service: number;
      health_check_interval_ms?: number;
    };
  };
}

/**
 * 設定頁面
 */
export const SettingsPage: FC<SettingsPageProps> = ({ settings }) => {
  const defaultLayer = settings.routing.default_layer
    ?? (
      settings.routing.default_strategy === 'fast'
        ? 'L1'
        : settings.routing.default_strategy === 'cheap'
          ? 'L3'
          : 'L2'
    );
  const healthCheckIntervalMs = settings.advanced.health_check_interval_ms ?? 60000;

  return (
    <Layout title="設定" activeNav="settings">
      <div class="page-header">
        <h1>{'\u2699\ufe0f'} 設定</h1>
        <div class="subtitle">管理 ClawAPI 引擎設定</div>
      </div>

      <form
        hx-put="/api/settings"
        hx-target="#settings-result"
        hx-swap="innerHTML"
      >
        {/* Server 設定 */}
        <div class="card" style="margin-bottom: 16px; max-width: 700px;">
          <h3 class="section-title">伺服器</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div class="form-group">
              <label for="server_host">監聽位址</label>
              <input type="text" name="server.host" id="server_host" value={settings.server.host} />
            </div>
            <div class="form-group">
              <label for="server_port">Port</label>
              <input type="number" name="server.port" id="server_port" value={String(settings.server.port)} />
            </div>
          </div>
        </div>

        {/* 路由設定 */}
        <div class="card" style="margin-bottom: 16px; max-width: 700px;">
          <h3 class="section-title">路由</h3>
          <div class="form-group">
            <label for="default_layer">預設路由層級</label>
            <select name="routing.default_layer" id="default_layer">
              {['L1', 'L2', 'L3', 'L4'].map((l) => (
                <option value={l} selected={l === defaultLayer}>{l}</option>
              ))}
            </select>
            <div class="form-hint">L1=直轉 L2=智慧路由 L3=品質優先 L4=任務型</div>
          </div>
        </div>

        {/* 功能開關 */}
        <div class="card" style="margin-bottom: 16px; max-width: 700px;">
          <h3 class="section-title">功能開關</h3>
          <div class="form-group">
            <label>
              <input
                type="checkbox"
                name="l0.enabled"
                value="true"
                checked={settings.l0.enabled}
                style="margin-right: 8px;"
              />
              L0 免費額度偵測
            </label>
          </div>
          <div class="form-group">
            <label>
              <input
                type="checkbox"
                name="aid.enabled"
                value="true"
                checked={settings.aid.enabled}
                style="margin-right: 8px;"
              />
              互助功能
            </label>
          </div>
          <div class="form-group">
            <label>
              <input
                type="checkbox"
                name="telemetry.enabled"
                value="true"
                checked={settings.telemetry.enabled}
                style="margin-right: 8px;"
              />
              匿名遙測（幫助改善集體智慧）
            </label>
          </div>
        </div>

        {/* 進階設定 */}
        <div class="card" style="margin-bottom: 16px; max-width: 700px;">
          <h3 class="section-title">進階</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div class="form-group">
              <label for="max_keys">每服務最大 Key 數</label>
              <input
                type="number"
                name="advanced.max_keys_per_service"
                id="max_keys"
                value={String(settings.advanced.max_keys_per_service)}
              />
            </div>
            <div class="form-group">
              <label for="health_interval">健康檢查間隔（ms）</label>
              <input
                type="number"
                name="advanced.health_check_interval_ms"
                id="health_interval"
                value={String(healthCheckIntervalMs)}
              />
            </div>
          </div>
          {/* Ollama 設定 */}
          <div class="form-group">
            <label>
              <input
                type="checkbox"
                name="l0.ollama_auto_detect"
                value="true"
                checked={settings.l0.ollama_auto_detect}
                style="margin-right: 8px;"
              />
              自動偵測 Ollama
            </label>
          </div>
          <div class="form-group">
            <label for="ollama_url">Ollama URL</label>
            <input
              type="text"
              name="l0.ollama_url"
              id="ollama_url"
              value={settings.l0.ollama_url}
              placeholder="http://localhost:11434"
            />
          </div>
        </div>

        <div class="btn-group">
          <button type="submit" class="btn btn-primary">儲存設定</button>
        </div>
      </form>

      <div id="settings-result" style="margin-top: 16px; max-width: 700px;"></div>
    </Layout>
  );
};

export default SettingsPage;
