import fs from 'fs/promises';
import path from 'path';
import zipper from 'zipper';
import Utils from './Utils.cjs';
import { addToThemeSummary, collectThemeData, summariseThemeData } from './ThemeData.js';

// some hosting setups put a bot filter in front of the site that rejects non-browser user agents with a 403
const USER_AGENT = process.env.AT_MIGRATE_UA || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LOGIN_ERRORS = { 1: 'invalid credentials', 2: 'account locked', 3: 'missing fields', 4: 'tenant disabled', 5: 'account inactive' };

// legacy mongoose strips top-level editorOnly attributes on export, inherited via each schema's $ref chain
const TRACKED_ONLY = ['createdAt', 'createdBy', '_isDeleted', 'updatedAt', 'updatedBy', 'deletedAt', 'deletedBy'];
const TENANT_ONLY = [...TRACKED_ONLY, '_tenantId'];
const CONTENT_ONLY = [...TENANT_ONLY, '_courseId', '_sortOrder', '_colorLabel'];
const EDITOR_ONLY = {
  course: [...TENANT_ONLY, 'themeSettings', 'heroImage', 'tags', '_isSelected', '_hasPreview', '_isShared', '_shareWithUsers'],
  config: [],
  contentobject: CONTENT_ONLY,
  article: CONTENT_ONLY,
  block: [...CONTENT_ONLY, 'layoutOptions'],
  component: [...TRACKED_ONLY, '_componentType', '_courseId', '_colorLabel', '_componentTypeDisplayName']
};
const CONTENT_FILES = { contentobject: 'contentObjects.json', article: 'articles.json', block: 'blocks.json', component: 'components.json' };
const PLUGIN_TYPES = [
  { type: 'component', folder: 'components' },
  { type: 'extension', folder: 'extensions' },
  { type: 'theme', folder: 'theme' },
  { type: 'menu', folder: 'menu' }
];

let IS_DEBUG;

/**
 * Builds an at-migrate bundle from a legacy site's REST API, so no server access is needed.
 * Course zips are assembled locally from the content JSON and assets rather than via the
 * legacy export route; plugin source is not included, only a bower.json stub per plugin
 * so the v1 import can resolve versions for migrations and the enabled plugin list.
 */
export default class RemoteExporter {
  constructor({ siteUrl, email, password, outputPath, courseIds, IS_DEBUG: isDebug, LIMIT }) {
    IS_DEBUG = isDebug;
    this.siteUrl = siteUrl.replace(/\/$/, '');
    this.credentials = { email, password };
    this.courseIds = courseIds;
    this.limit = LIMIT !== undefined ? Number(LIMIT) : undefined;
    this.exportPath = path.join(outputPath, Date.now().toString());
    this.cookies = new Map();
    this.themeSummary = {};
    this.metadata = { source: this.siteUrl, remote: true, status: { success: [], error: [] }, warnings: [] };
  }

  async run() {
    await fs.mkdir(path.join(this.exportPath, 'heroes'), { recursive: true });
    await fs.mkdir(path.join(this.exportPath, 'theme-data'), { recursive: true });
    this.frameworkVersion = await this.getFrameworkVersion();
    await this.login();
    await this.exportRoles();
    await this.exportUsers();
    await this.exportThemePresets();
    await this.loadPluginTypes();
    await this.exportCourses();
    await this.saveMetadata();
    return this.metadata;
  }

  warn(message) {
    this.metadata.warnings.push(message);
    console.warn(` ! ${message}`);
  }

  async request(endpoint, { method = 'GET', body, raw = false, retries = 1 } = {}) {
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': raw ? '*/*' : 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest'
    };
    if(this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if(body) headers['Content-Type'] = 'application/json';
    const url = `${this.siteUrl}${endpoint}`;
    debug(method, url);
    const res = await fetch(url, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    for(const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if(!res.ok) {
      const text = await res.text();
      // a heavy request can hit the gateway timeout, which usually succeeds on a second ask
      if(res.status >= 500 && retries > 0 && method === 'GET') {
        debug(`retrying ${endpoint} after ${res.status}`);
        return this.request(endpoint, { method, body, raw, retries: retries - 1 });
      }
      let message = text.slice(0, 200);
      try { message = JSON.parse(text).message ?? message; } catch {}
      const e = new Error(`${method} ${endpoint} failed (${res.status}): ${message}`);
      e.status = res.status;
      e.body = text;
      throw e;
    }
    if(raw) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  async getFrameworkVersion() {
    // the version attributes are populated asynchronously after boot, so the first render can be blank
    for(let i = 0; i < 2; i++) {
      const html = (await this.request('/', { raw: true })).toString();
      const version = html.match(/data-adapt-framework-version="([^"]+)"/)?.[1];
      if(version) {
        console.log(`Legacy site is running framework v${version}`);
        return version;
      }
    }
    throw new Error('Could not determine the framework version of the legacy site');
  }

  async login() {
    // a failed login counts towards the account lockout, so never retry
    try {
      await this.request('/api/login', { method: 'POST', body: this.credentials, retries: 0 });
    } catch(e) {
      let code;
      try { code = JSON.parse(e.body).errorCode; } catch {}
      throw new Error(`Login failed: ${LOGIN_ERRORS[code] ?? e.message}${code ? ` (errorCode ${code})` : ''}`);
    }
    const auth = await this.request('/api/authcheck');
    if(!auth?.isAuthenticated) throw new Error('Login appeared to succeed, but the session is not authenticated');
    this.tenantId = auth.tenantId;
    console.log(`Logged in to tenant '${auth.tenantName}'`);
  }

  async exportRoles() {
    this.metadata.roles = (await this.request('/api/role')).map(r => ({ _id: r._id, name: r.name }));
    console.log(`Exported ${this.metadata.roles.length} roles`);
  }

  async exportUsers() {
    const users = await this.request('/api/user');
    const roleNameById = new Map(this.metadata.roles.map(r => [r._id, r.name]));
    const roleless = [];
    this.metadata.users = [];
    for(const u of users) {
      if(!u.email) {
        this.warn(`User ${u._id} has no email address, omitting from the export`);
        continue;
      }
      // roles arrive populated with their names, but fall back to the id lookup in case they aren't
      const roleNames = (u.roles ?? [])
        .map(r => (typeof r === 'object' && r !== null) ? r.name : roleNameById.get(r))
        .filter(Boolean);
      if(!roleNames.length) roleless.push(u.email);
      this.metadata.users.push({
        _id: u._id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        roleNames,
        _tenantId: u._tenantId?._id ?? u._tenantId
      });
    }
    if(roleless.length) {
      this.warn(`${roleless.length} user(s) have no valid roles and will be imported with none: ${summarise(roleless)}`);
    }
    console.log(`Exported ${this.metadata.users.length} users`);
  }

  async exportThemePresets() {
    this.metadata.themePresets = (await this.request('/api/content/themepreset')).map(p => ({
      _id: p._id,
      displayName: p.displayName,
      parentTheme: p.parentTheme,
      properties: p.properties
    }));
    console.log(`Exported ${this.metadata.themePresets.length} theme presets`);
  }

  async loadPluginTypes() {
    this.pluginTypes = {};
    for(const { type } of PLUGIN_TYPES) {
      this.pluginTypes[type] = await this.request(`/api/${type}type`);
    }
    debug('plugin types', Object.fromEntries(Object.entries(this.pluginTypes).map(([k, v]) => [k, v.length])));
  }

  async exportCourses() {
    const courses = await this.request('/api/content/course');
    const tags = await this.request('/api/content/tag');
    const tagTitleById = new Map(tags.filter(t => t.title).map(t => [t._id, t.title]));
    console.log(`Found ${courses.length} courses on the site`);

    let selected = courses;
    if(this.courseIds?.length) {
      selected = courses.filter(c => this.courseIds.includes(c._id));
      const missing = this.courseIds.filter(id => !courses.some(c => c._id === id));
      if(missing.length) this.warn(`Requested course(s) not visible to this account: ${missing.join(', ')}`);
    }
    if(this.limit !== undefined) selected = selected.slice(0, this.limit);

    this.metadata.courses = selected.map(c => ({
      _id: c._id,
      title: c.title,
      heroImage: c.heroImage || undefined,
      _isShared: c._isShared || undefined,
      _shareWithUsers: c._shareWithUsers?.length ? c._shareWithUsers : undefined,
      createdBy: c.createdBy,
      tags: resolveTags(c.tags, tagTitleById)
    }));
    console.log(`Attempting to export ${this.metadata.courses.length} courses`);

    for(const [i, course] of this.metadata.courses.entries()) {
      const raw = selected[i];
      console.log(`Exporting ${course._id} ${course.title}`);
      try {
        await this.exportCourse(course, raw);
        this.metadata.status.success.push(course._id);
        console.log(`  Exported ${course._id} ${course.title}`);
      } catch(e) {
        console.error(`  Failed ${course._id} ${course.title}: ${e.message}`);
        if(IS_DEBUG) console.error(e.stack);
        this.metadata.status.error.push({ _courseId: course._id, message: e.message });
      }
      await this.saveMetadata();
    }
    console.log(`${this.metadata.status.success.length} courses exported successfully`);
    await Utils.writeJson(path.join(this.exportPath, 'theme-data', 'summary.json'), this.themeSummary);
  }

  async getCourseContent(type, courseId) {
    return this.request(`/api/content/${type}?_courseId=${courseId}`);
  }

  async exportCourse(course, raw) {
    const courseId = course._id;
    const [configs, contentobject, article, block, component, courseassets] = await Promise.all(
      ['config', 'contentobject', 'article', 'block', 'component', 'courseasset'].map(t => this.getCourseContent(t, courseId))
    );
    if(configs.length !== 1) throw new Error(`Expected 1 config, found ${configs.length}`);
    const config = configs[0];
    const lang = config._defaultLanguage || 'en';
    if(lang !== 'en') this.warn(`Course '${course.title}' uses language '${lang}', but the importer expects 'en'`);

    course.themePreset = config._themePreset || undefined;
    const owner = course.createdBy && this.metadata.users.find(u => u._id === course.createdBy);
    if(!owner) this.warn(`Course '${course.title}' has an unknown owner (${course.createdBy}), it will be imported unowned`);
    course.createdBy = owner?.email;

    const plugins = this.getCoursePlugins(course, config, component);
    const json = {
      course: this.transformCourse(raw, block.length),
      config: this.transformConfig(config),
      contentobject: sortContent(contentobject).map(c => this.transformItem('contentobject', c, courseId)),
      article: sortContent(article).map(c => this.transformItem('article', c, courseId)),
      block: sortContent(block).map(c => this.transformItem('block', c, courseId)),
      component: sortContent(component).map(c => this.transformItem('component', c, courseId))
    };
    json.block.forEach((b, i) => { b._trackingId = i + 1; });

    const workDir = path.join(this.exportPath, `${courseId}_src`);
    const courseDir = path.join(workDir, 'src', 'course');
    const langDir = path.join(courseDir, lang);
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(path.join(langDir, 'assets'), { recursive: true });

    const assetCount = await this.writeAssets(courseassets, json, lang, langDir);
    await this.exportThemeData(course, config, json, courseassets);

    await Utils.writeJson(path.join(workDir, 'package.json'), { name: 'adapt_framework', version: this.frameworkVersion });
    await Utils.writeJson(path.join(courseDir, 'config.json'), json.config);
    await Utils.writeJson(path.join(langDir, 'course.json'), json.course);
    for(const [type, filename] of Object.entries(CONTENT_FILES)) {
      await Utils.writeJson(path.join(langDir, filename), json[type]);
    }
    for(const p of plugins) {
      const dir = path.join(workDir, 'src', p.folder, p.name);
      await fs.mkdir(dir, { recursive: true });
      await Utils.writeJson(path.join(dir, 'bower.json'), p.bower);
    }
    if(course.heroImage) await this.exportHeroImage(course);

    course.path = `${courseId}.zip`;
    course.counts = {
      contentobject: json.contentobject.length,
      article: json.article.length,
      block: json.block.length,
      component: json.component.length,
      assets: assetCount,
      plugins: plugins.length
    };
    await fs.rm(path.join(this.exportPath, course.path), { force: true });
    await zipper.zip(workDir, path.join(this.exportPath, course.path), { removeSource: !IS_DEBUG });
  }

  async exportThemeData(course, config, json, courseassets) {
    const themeType = this.pluginTypes.theme.find(t => t.name === config._theme);
    const menuType = this.pluginTypes.menu.find(t => t.name === config._menu);
    const preset = course.themePreset && this.metadata.themePresets.find(p => p._id === course.themePreset);
    // the legacy export leaves theme-linked assets out of the course, as this one does
    const themeAssetIds = [...new Set(courseassets.filter(a => a._contentType === 'theme').map(a => a._assetId))];
    if(themeAssetIds.length) this.warn(`Course '${course.title}' has ${themeAssetIds.length} theme asset(s), which aren't exported`);
    const data = collectThemeData({ json, themeName: config._theme, themeType, menuName: config._menu, menuType, preset, themeAssetIds });
    await this.writePluginSchema('themes', themeType, data.theme);
    await this.writePluginSchema('menus', menuType, data.menu);
    await Utils.writeJson(path.join(this.exportPath, 'theme-data', `${course._id}.json`), data);
    course.theme = summariseThemeData(data);
    addToThemeSummary(this.themeSummary, course._id, data);
  }

  // legacy keeps only the schema's properties on the plugin record, so that's all that can be recovered
  async writePluginSchema(folder, pluginType, described) {
    if(!described.hasPropertiesSchema) return;
    const schemaPath = path.join(this.exportPath, 'theme-data', folder, `${pluginType.name}@${pluginType.version}.properties.schema.json`);
    await fs.mkdir(path.dirname(schemaPath), { recursive: true });
    await Utils.writeJson(schemaPath, { properties: pluginType.properties });
  }

  transformCourse(raw, blockCount) {
    const course = stripFields(flattenNested(clone(raw)), EDITOR_ONLY.course);
    course._id = 'course';
    course._type = 'course';
    course._latestTrackingId = blockCount;
    // legacy writes customStyle into the theme folder, which isn't exported; the v1 import reads it from the course instead
    return course;
  }

  transformConfig(raw) {
    const config = stripFields(flattenNested(clone(raw)), [...EDITOR_ONLY.config, '_themePreset', '_theme', '_menu', '_enabledExtensions', '_enabledComponents']);
    delete config.__v;
    return config;
  }

  transformItem(type, raw, courseId) {
    const item = flattenNested(clone(raw));
    if(type === 'component' && item.properties) {
      Object.assign(item, item.properties);
      delete item.properties;
    }
    if(item._parentId === courseId) item._parentId = 'course';
    if(Array.isArray(item.tags)) item.tags = item.tags.map(t => t?._id ?? t);
    return stripFields(item, EDITOR_ONLY[type]);
  }

  getCoursePlugins(course, config, components) {
    const wanted = { component: new Set(), extension: new Set(), theme: new Set(), menu: new Set() };
    if(config._theme) wanted.theme.add(config._theme);
    if(config._menu) wanted.menu.add(config._menu);
    Object.values(config._enabledExtensions ?? {}).forEach(e => e?.name && wanted.extension.add(e.name));
    const componentTypes = this.pluginTypes.component;
    for(const c of components) {
      const match = componentTypes.find(t => t.component === c._component);
      if(match) wanted.component.add(match.name);
      else this.warn(`Course '${course.title}': no installed component matches '${c._component}' (${c._id})`);
    }
    const plugins = [];
    for(const { type, folder } of PLUGIN_TYPES) {
      for(const name of wanted[type]) {
        const p = this.pluginTypes[type].find(t => t.name === name);
        if(!p) {
          this.warn(`Course '${course.title}': ${type} '${name}' isn't installed on the legacy site, omitted`);
          continue;
        }
        const bower = { name: p.name, version: toSemver(p.version), [type]: p[type] };
        if(bower.version !== p.version) {
          // v1 refuses an invalid version outright rather than quarantining the plugin
          this.warn(`Course '${course.title}': ${type} '${name}' has a non-semver version (${p.version}), exported as ${bower.version}`);
        }
        if(p.displayName) bower.displayName = p.displayName;
        if(p.targetAttribute) bower.targetAttribute = p.targetAttribute;
        if(p.framework) bower.framework = p.framework;
        plugins.push({ folder, name: p.name, bower });
      }
    }
    return plugins;
  }

  async writeAssets(courseassets, json, lang, langDir) {
    const assetIds = [...new Set(courseassets.filter(a => a._contentType !== 'theme').map(a => a._assetId))];
    const assetsJson = {};
    for(const id of assetIds) {
      const asset = await this.request(`/api/asset/${id}`);
      const data = await this.request(`/api/asset/serve/${id}`, { raw: true });
      await fs.writeFile(path.join(langDir, 'assets', asset.filename), data);
      assetsJson[asset.filename] = {
        title: asset.title,
        description: asset.description,
        tags: asset.tags
      };
      const re = new RegExp(`course/assets/${escapeRegExp(asset.filename)}`, 'gi');
      const replacement = `course/${lang}/assets/${encodeURIComponent(asset.filename)}`;
      for(const key of Object.keys(json)) {
        json[key] = JSON.parse(JSON.stringify(json[key]).replace(re, replacement));
      }
    }
    if(assetIds.length) await Utils.writeJson(path.join(langDir, 'assets.json'), assetsJson);
    return assetIds.length;
  }

  async exportHeroImage(course) {
    try {
      const asset = await this.request(`/api/asset/${course.heroImage}`);
      const data = await this.request(`/api/asset/serve/${course.heroImage}`, { raw: true });
      await fs.writeFile(path.join(this.exportPath, 'heroes', asset.filename), data);
      course.heroImage = `heroes/${asset.filename}`;
    } catch(e) {
      this.warn(`Course '${course.title}': hero image ${course.heroImage} could not be exported (${e.message})`);
      course.heroImage = undefined;
    }
  }

  saveMetadata() {
    return Utils.writeJson(path.join(this.exportPath, 'export.json'), this.metadata);
  }
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function stripFields(item, fields) {
  [...fields, '__v'].forEach(f => delete item[f]);
  return item;
}

// mirrors the legacy flattenNestedObjects: hoist without overwriting, then drop the wrapper
function flattenNested(item) {
  for(const attr of ['_extensions', 'menuSettings', 'themeSettings']) {
    if(!item[attr]) continue;
    for(const key of Object.keys(item[attr])) {
      if(!item[key]) item[key] = item[attr][key];
    }
    delete item[attr];
  }
  return item;
}

// legacy sorts on _sortOrder alone, with ties falling back to natural (insertion) order
function sortContent(items) {
  return [...items].sort((a, b) => (a._sortOrder ?? 0) - (b._sortOrder ?? 0) || String(a._id).localeCompare(String(b._id)));
}

function resolveTags(tags, tagTitleById) {
  const titles = (tags ?? []).map(t => (typeof t === 'object' && t !== null) ? t.title : tagTitleById.get(t)).filter(Boolean);
  return titles.length ? titles : undefined;
}

function toSemver(version) {
  if(/^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/.test(version ?? '')) return version;
  return (version ?? '').match(/^\d+\.\d+\.\d+/)?.[0] ?? '0.0.0';
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summarise(list, max = 5) {
  return list.length > max ? `${list.slice(0, max).join(', ')} and ${list.length - max} more` : list.join(', ');
}

function debug(...args) {
  if(IS_DEBUG) console.log('DEBUG::', ...args);
}
