# Migration

## Users/roles
- No migration of old roles?
- Create role map config (name => shortname?)
- Data:
  * firstName
  * lastName
  * email
  * roles

```js
const [superuser] = await roles.find({ shortName });
await localauth.register(Object.assign({}, data, {
  firstName: 'Super',
  lastName: 'User',
  roles: [superuser._id.toString()]
}));
```

## Assets
- Probably needs to go in before content (to create an id map)
- Get dump of all assets in system
- Move all assets/thumbs to required location
- Run each asset DB data through assets create API
- Rename asset file as appropriate once DB doc created
- Store map from old filename to new
- Data: 
  * title
  * description
  * metadata
  * size
  * path
  * assetType => type
```js
assets.insert(data);
```

## Tags
- Assets

## Plugins
- Collections:
  * componenttypes
  * extensiontypes
  * menutypes
  * themetypes
- Skip any with isLocalPackage: false??? (i.e. managed by CLI)
- Safe to grab code from /temp/adapt_framework/src/*/PLUGIN_NAME???

```js
contentplugin.manualInstallPlugin(zipPath, { isZip: false });
```

## Course content
