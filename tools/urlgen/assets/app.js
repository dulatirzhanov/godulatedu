(function () {
  'use strict';

  const STORAGE_KEY = 'utmgen:v1';
  const HEADER = 'timestamp,slug,destination_base,utm_source,utm_medium,utm_campaign,utm_term,utm_content,final_url';
  const SLUG_LENGTH = 4;
  const SLUG_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  const ownerInput = document.getElementById('owner');
  const repoInput = document.getElementById('repo');
  const branchInput = document.getElementById('branch');
  const tokenInput = document.getElementById('token');
  const saveSettingsBtn = document.getElementById('save-settings');
  const settingsStatus = document.getElementById('settings-status');

  const destinationInput = document.getElementById('destination');
  const utmSourceInput = document.getElementById('utm-source');
  const utmMediumInput = document.getElementById('utm-medium');
  const utmCampaignInput = document.getElementById('utm-campaign');
  const utmTermInput = document.getElementById('utm-term');
  const utmContentInput = document.getElementById('utm-content');
  const generateBtn = document.getElementById('generate');
  const generateStatus = document.getElementById('generate-status');
  const resultWrapper = document.getElementById('result');
  const shortUrlEl = document.getElementById('short-url');
  const finalUrlEl = document.getElementById('final-url');
  const recentLinksEl = document.getElementById('recent-links');

  function decodeBase64(content) {
    const cleaned = content.replace(/\n/g, '');
    const binary = atob(cleaned);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach(b => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }

  function loadConfig() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { owner: '', repo: '', branch: '', token: '' };
      }
      const parsed = JSON.parse(raw);
      return {
        owner: parsed.owner || '',
        repo: parsed.repo || '',
        branch: parsed.branch || '',
        token: parsed.token || ''
      };
    } catch (error) {
      console.warn('Failed to load config', error);
      return { owner: '', repo: '', branch: '', token: '' };
    }
  }

  function saveConfig(config) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function applyConfigToInputs() {
    const config = loadConfig();
    ownerInput.value = config.owner;
    repoInput.value = config.repo;
    branchInput.value = config.branch;
    tokenInput.value = config.token;
  }

  function collectConfigFromInputs() {
    return {
      owner: ownerInput.value.trim(),
      repo: repoInput.value.trim(),
      branch: branchInput.value.trim(),
      token: tokenInput.value.trim()
    };
  }

  function configIsComplete(config) {
    return Boolean(config.owner && config.repo && config.branch && config.token);
  }

  function setSettingsStatus(message, isError) {
    settingsStatus.textContent = message || '';
    settingsStatus.style.color = isError ? '#dc2626' : '#047857';
  }

  function setGenerateStatus(message, isError) {
    generateStatus.textContent = message || '';
    generateStatus.style.color = isError ? '#dc2626' : '#1f2937';
  }

  function buildApiUrl(config, path) {
    const pathSegments = path.split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${pathSegments}?ref=${encodeURIComponent(config.branch)}`;
  }

  async function ghGet(config, path) {
    const response = await fetch(buildApiUrl(config, path), {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json'
      }
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GET ${path} failed: ${response.status} ${errorBody}`);
    }

    const json = await response.json();
    const content = json.content ? decodeBase64(json.content) : '';
    return { sha: json.sha, content };
  }

  async function ghPut(config, path, textContent, message, sha) {
    const body = {
      message,
      content: encodeBase64(textContent),
      branch: config.branch
    };
    if (sha) {
      body.sha = sha;
    }

    const response = await fetch(buildApiUrl(config, path), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`PUT ${path} failed: ${response.status} ${errorBody}`);
    }

    return response.json();
  }

  function generateSlug(existing) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let slug = '';
      for (let i = 0; i < SLUG_LENGTH; i += 1) {
        const index = Math.floor(Math.random() * SLUG_CHARS.length);
        slug += SLUG_CHARS.charAt(index);
      }
      if (!existing[slug]) {
        return slug;
      }
    }
    throw new Error('Unable to generate a unique slug after 50 attempts.');
  }

  function ensureHttpUrl(value) {
    return /^https?:\/\//i.test(value);
  }

  function escapeCsv(value) {
    return (value || '').toString().replace(/,/g, '%2C');
  }

  async function updateRecentLinks() {
    const config = loadConfig();
    if (!configIsComplete(config)) {
      recentLinksEl.textContent = `${HEADER}\nSave settings to load recent links.`;
      return;
    }

    try {
      const csvData = await ghGet(config, 'data/links.csv');
      if (!csvData || !csvData.content) {
        recentLinksEl.textContent = HEADER;
        return;
      }
      const trimmed = csvData.content.trimEnd();
      const lines = trimmed.split('\n');
      const header = lines.shift() || HEADER;
      const dataLines = lines.filter(line => line.trim().length > 0);
      const lastTen = dataLines.slice(-10);
      recentLinksEl.textContent = lastTen.length ? `${header}\n${lastTen.join('\n')}` : header;
    } catch (error) {
      console.error(error);
      recentLinksEl.textContent = `${HEADER}\nUnable to load recent links.`;
    }
  }

  async function handleGenerate() {
    setGenerateStatus('', false);
    resultWrapper.hidden = true;

    const config = loadConfig();
    if (!configIsComplete(config)) {
      setGenerateStatus('Save GitHub settings before generating links.', true);
      return;
    }

    const destination = destinationInput.value.trim();
    const utmSource = utmSourceInput.value.trim();
    const utmMedium = utmMediumInput.value.trim();
    const utmCampaign = utmCampaignInput.value.trim();
    const utmTerm = utmTermInput.value.trim();
    const utmContent = utmContentInput.value.trim();

    if (!ensureHttpUrl(destination)) {
      setGenerateStatus('Destination URL must start with http:// or https://', true);
      return;
    }

    if (!utmSource || !utmMedium || !utmCampaign) {
      setGenerateStatus('utm_source, utm_medium, and utm_campaign are required.', true);
      return;
    }

    generateBtn.disabled = true;
    setGenerateStatus('Generating short link…', false);

    try {
      const mappingData = await ghGet(config, 'data/mapping.json');
      const mappingText = mappingData && mappingData.content ? mappingData.content : '{}';
      const mappingSha = mappingData ? mappingData.sha : undefined;
      let mapping;
      try {
        mapping = JSON.parse(mappingText);
      } catch (parseError) {
        throw new Error('mapping.json is not valid JSON.');
      }

      const slug = generateSlug(mapping);
      const url = new URL(destination);
      url.searchParams.set('utm_source', utmSource);
      url.searchParams.set('utm_medium', utmMedium);
      url.searchParams.set('utm_campaign', utmCampaign);
      if (utmTerm) {
        url.searchParams.set('utm_term', utmTerm);
      }
      if (utmContent) {
        url.searchParams.set('utm_content', utmContent);
      }
      const finalUrl = url.toString();
      const timestamp = new Date().toISOString();

      mapping[slug] = {
        destination_url: destination,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        utm_term: utmTerm,
        utm_content: utmContent,
        final_url: finalUrl,
        created_at: timestamp
      };

      const mappingJson = `${JSON.stringify(mapping, null, 2)}\n`;
      await ghPut(config, 'data/mapping.json', mappingJson, `add short link ${slug}`, mappingSha);

      const csvData = await ghGet(config, 'data/links.csv');
      const csvSha = csvData ? csvData.sha : undefined;
      let csvText = csvData && csvData.content ? csvData.content : `${HEADER}\n`;
      if (!csvText.endsWith('\n')) {
        csvText += '\n';
      }
      const csvLine = [
        timestamp,
        slug,
        escapeCsv(destination),
        escapeCsv(utmSource),
        escapeCsv(utmMedium),
        escapeCsv(utmCampaign),
        escapeCsv(utmTerm),
        escapeCsv(utmContent),
        escapeCsv(finalUrl)
      ].join(',');
      csvText += `${csvLine}\n`;

      await ghPut(config, 'data/links.csv', csvText, `append CSV for ${slug}`, csvSha);

      const shortUrl = `https://go.dulatedu.com/${slug}`;
      shortUrlEl.textContent = shortUrl;
      shortUrlEl.href = shortUrl;
      finalUrlEl.textContent = finalUrl;
      resultWrapper.hidden = false;
      setGenerateStatus('Short link created successfully.', false);
      updateRecentLinks();
    } catch (error) {
      console.error(error);
      setGenerateStatus(error.message || 'Failed to generate short link.', true);
    } finally {
      generateBtn.disabled = false;
    }
  }

  saveSettingsBtn.addEventListener('click', function () {
    const config = collectConfigFromInputs();
    if (!config.owner || !config.repo || !config.branch || !config.token) {
      setSettingsStatus('All fields are required to save settings.', true);
      return;
    }
    saveConfig(config);
    setSettingsStatus('Settings saved.', false);
    updateRecentLinks();
  });

  generateBtn.addEventListener('click', function () {
    handleGenerate();
  });

  applyConfigToInputs();
  updateRecentLinks();
})();
