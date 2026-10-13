// legacy content types, mapped to the pluginLocations key a plugin's properties.schema uses for them
const LOCATIONS = { course: 'course', config: 'config', contentobject: 'contentobject', article: 'article', block: 'block', component: 'component' };
const LESS_AT_RULES = new Set(['media', 'import', 'keyframes', 'font-face', 'supports', 'charset', 'namespace', 'page', 'plugin', 'arguments', 'rest']);
const HTML_CLASS_RE = /\bclass\s*=\s*(["'])(.*?)\1/gi;
const HTML_STYLE_RE = /\bstyle\s*=\s*(["'])(.*?)\1/gi;

/**
 * Notes the custom styling data a course carries, which the v1 import can't be relied on to keep:
 * theme and menu attributes are dropped when the plugin isn't installed, and classes and custom LESS
 * are only meaningful against the theme they were written for
 * @param {Object} options
 * @param {Object} options.json The course's transformed content, keyed by type
 * @param {String} options.themeName The theme the course uses
 * @param {Object} [options.themeType] The legacy theme plugin record, which holds its properties.schema
 * @param {String} options.menuName The menu the course uses
 * @param {Object} [options.menuType] The legacy menu plugin record
 * @param {Object} [options.preset] The theme preset applied to the course
 * @param {Array<String>} [options.themeAssetIds] Assets linked to the course's theme rather than its content
 * @return {Object}
 */
export function collectThemeData({ json, themeName, themeType, menuName, menuType, preset, themeAssetIds = [] }) {
  const variablesSchema = themeType?.properties?.variables;
  return {
    theme: describePlugin(themeName, themeType),
    menu: describePlugin(menuName, menuType),
    classes: findClasses(json),
    inlineStyles: findInlineStyles(json),
    themeAttributes: findPluginAttributes(json, themeType?.properties?.pluginLocations),
    menuAttributes: findPluginAttributes(json, menuType?.properties?.pluginLocations),
    themeVariables: {
      values: json.course.themeVariables,
      customised: diffFromDefaults(json.course.themeVariables, variablesSchema)
    },
    preset: preset && {
      _id: preset._id,
      displayName: preset.displayName,
      parentTheme: preset.parentTheme,
      customised: diffFromDefaults(preset.properties, variablesSchema)
    },
    customStyle: describeLess(json.course.customStyle),
    screenSize: json.config.screenSize ?? json.config._screenSize,
    themeAssetIds
  };
}

/**
 * Condenses a course's theme data for export.json
 * @param {Object} data From collectThemeData
 * @return {Object}
 */
export function summariseThemeData(data) {
  return {
    name: data.theme.name,
    version: data.theme.version,
    hasPropertiesSchema: data.theme.hasPropertiesSchema,
    menu: data.menu.name,
    customClasses: Object.keys(data.classes).length,
    itemsWithClasses: new Set(Object.values(data.classes).flat().map(l => l._id)).size,
    itemsWithInlineStyles: new Set(data.inlineStyles.map(s => s._id)).size,
    itemsWithThemeAttributes: data.themeAttributes.length,
    itemsWithMenuAttributes: data.menuAttributes.length,
    customisedVariables: Object.keys(data.themeVariables.customised).length,
    preset: data.preset?.displayName,
    customStyleLines: data.customStyle?.lines ?? 0,
    themeAssets: data.themeAssetIds.length
  };
}

/**
 * Folds one course's data into per-theme and per-menu summaries across the whole export
 * @param {Object} summary Accumulated summary, with themes and menus keyed by name@version
 * @param {String} courseId
 * @param {Object} data From collectThemeData
 */
export function addToThemeSummary(summary, courseId, data) {
  const theme = getSummaryEntry(summary.themes ??= {}, data.theme, {
    coursesWithCustomVariables: 0,
    coursesWithPreset: 0,
    coursesWithCustomStyle: 0,
    coursesWithThemeAttributes: 0,
    coursesWithInlineStyles: 0,
    coursesWithThemeAssets: 0,
    classes: {},
    inlineStyleProperties: {},
    customStyleVariables: {},
    customStyleClasses: {},
    screenSizes: {}
  });
  theme.courses.push(courseId);
  if(Object.keys(data.themeVariables.customised).length) theme.coursesWithCustomVariables++;
  if(data.preset) theme.coursesWithPreset++;
  if(data.customStyle) theme.coursesWithCustomStyle++;
  if(data.themeAttributes.length) theme.coursesWithThemeAttributes++;
  if(data.inlineStyles.length) theme.coursesWithInlineStyles++;
  if(data.themeAssetIds.length) theme.coursesWithThemeAssets++;
  countInto(theme.classes, Object.keys(data.classes));
  countInto(theme.inlineStyleProperties, [...new Set(data.inlineStyles.flatMap(s => s.properties))]);
  countInto(theme.customStyleVariables, data.customStyle?.variables ?? []);
  countInto(theme.customStyleClasses, data.customStyle?.classes ?? []);
  countInto(theme.screenSizes, data.screenSize ? [JSON.stringify(data.screenSize)] : []);

  const menu = getSummaryEntry(summary.menus ??= {}, data.menu, { coursesWithMenuAttributes: 0 });
  menu.courses.push(courseId);
  if(data.menuAttributes.length) menu.coursesWithMenuAttributes++;
}

function getSummaryEntry(group, plugin, counters) {
  const key = `${plugin.name}@${plugin.version ?? 'unknown'}`;
  return group[key] ??= { ...plugin, courses: [], ...counters };
}

function countInto(counts, keys) {
  keys.forEach(k => { counts[k] = (counts[k] ?? 0) + 1; });
}

function describePlugin(name, pluginType) {
  const schema = pluginType?.properties;
  return {
    name,
    version: pluginType?.version,
    targetAttribute: pluginType?.targetAttribute,
    isInstalled: !!pluginType,
    hasPropertiesSchema: !!schema && Object.keys(schema).length > 0
  };
}

// classes come from _classes on any item or plugin sub-item, and from class attributes in rich text
function findClasses(json) {
  const classes = {};
  walkContent(json, (key, value, location) => {
    if(typeof value !== 'string') return;
    if(key === '_classes') addClasses(classes, value, { ...location, source: '_classes' });
    for(const [, , names] of value.matchAll(HTML_CLASS_RE)) addClasses(classes, names, { ...location, source: 'richText' });
  });
  return classes;
}

function addClasses(classes, names, location) {
  names.split(/\s+/).filter(Boolean).forEach(c => (classes[c] ??= []).push(location));
}

function findInlineStyles(json) {
  const found = [];
  walkContent(json, (key, value, location) => {
    if(typeof value !== 'string') return;
    const styles = [...value.matchAll(HTML_STYLE_RE)].map(([, , style]) => style);
    if(!styles.length) return;
    const properties = [...new Set(styles.flatMap(s => s.split(';').map(d => d.split(':')[0].trim().toLowerCase()).filter(Boolean)))];
    found.push({ ...location, properties, styles });
  });
  return found;
}

function walkContent(json, visit) {
  for(const [type, items] of Object.entries(json)) {
    for(const item of [].concat(items)) {
      walk(item, [], (key, value, trail) => visit(key, value, { _id: item._id, _type: item._type ?? type, path: trail.join('.') }));
    }
  }
}

function walk(value, trail, visit) {
  if(!value || typeof value !== 'object') return;
  for(const [key, child] of Object.entries(value)) {
    const childTrail = [...trail, key];
    visit(key, child, childTrail);
    walk(child, childTrail, visit);
  }
}

function findPluginAttributes(json, pluginLocations) {
  const found = [];
  for(const [type, location] of Object.entries(LOCATIONS)) {
    const props = pluginLocations?.properties?.[location]?.properties ?? {};
    if(!Object.keys(props).length) continue;
    const defaults = {};
    flattenDefaults(props, [], defaults);
    for(const item of [].concat(json[type] ?? [])) {
      for(const key of Object.keys(props)) {
        // editors save the whole attribute object, so an untouched one is all nulls and defaults
        if(!hasSetValue(item[key], [key], defaults)) continue;
        found.push({ _id: item._id, _type: item._type ?? type, attribute: key, value: item[key] });
      }
    }
  }
  return found;
}

function hasSetValue(value, trail, defaults) {
  if(value === undefined || value === null || value === '') return false;
  if(Array.isArray(value)) return value.length > 0;
  if(typeof value === 'object') return Object.entries(value).some(([k, v]) => hasSetValue(v, [...trail, k], defaults));
  const key = trail.join('.');
  return key in defaults ? String(defaults[key]) !== String(value) : value !== 0 && value !== false;
}

// only values that differ from the theme's defaults are written out as LESS by the legacy build
function diffFromDefaults(values, variablesSchema) {
  const defaults = {};
  flattenDefaults(variablesSchema, [], defaults);
  const customised = {};
  flattenValues(values, [], (key, value) => {
    if(value === '' || value === null || value === undefined) return;
    if(defaults[key] === undefined || String(defaults[key]) !== String(value)) {
      customised[key] = { value, default: defaults[key] };
    }
  });
  return customised;
}

function flattenDefaults(schema, trail, out) {
  for(const [key, prop] of Object.entries(schema ?? {})) {
    if(prop?.properties) flattenDefaults(prop.properties, [...trail, key], out);
    else if(prop && 'default' in prop) out[[...trail, key].join('.')] = prop.default;
  }
}

function flattenValues(values, trail, visit) {
  for(const [key, value] of Object.entries(values ?? {})) {
    if(value && typeof value === 'object' && !Array.isArray(value)) flattenValues(value, [...trail, key], visit);
    else visit([...trail, key].join('.'), value);
  }
}

function describeLess(less) {
  if(!less?.trim()) return undefined;
  const code = less.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const variables = new Set();
  for(const [, name] of code.matchAll(/@\{?([a-zA-Z_-][\w-]*)\}?/g)) {
    if(!LESS_AT_RULES.has(name)) variables.add(`@${name}`);
  }
  const classes = new Set();
  // drop urls and strings so file extensions don't read as classes; a digit before the dot is a number (1.5em)
  const selectors = code.replace(/url\([^)]*\)/g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '');
  for(const [, name] of selectors.matchAll(/(?<!\d)\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(`.${name}`);
  return { lines: less.split('\n').length, variables: [...variables].sort(), classes: [...classes].sort() };
}
