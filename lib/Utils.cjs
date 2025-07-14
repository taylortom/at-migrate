const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

class Utils {
  get workingDir() {
    return path.join(process.cwd(), 'at-migrate');
  }
  static async loadJson(filepath) {
    return JSON.parse(await fsPromises.readFile(filepath));
  }
  static async loadJsonSync(filepath) {
    return JSON.parse(fs.readFileSync(filepath));
  }
  
  static async writeJson(filepath, data) {
    return fsPromises.writeFile(filepath, JSON.stringify(data, null, 2));
  }

  static async requestAll(endpoint, options = {}) {
    let page = 1;
    let fetch = true;
    let res;
    const data = [];
    while(fetch) {
      res = await Utils.request(`${endpoint}?page=${page}`, options);
      data.push(...res.data);
      if(page.toString() === res.headers.get('x-adapt-pagetotal')) fetch = false;
      else page++;
    }
    res.data = data;
    return res;
  }
  
  static async request(endpoint, options = {}) {
    const res = await fetch(`${options.apiUrl}/${endpoint}`, {
      ...options,
      headers: { 'Authorization': `Bearer ${options.authToken}`, ...options.headers }
    });
    try {
      let data = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        data += decoder.decode(chunk, { stream: true });
      }
      if(data) res.data = JSON.parse(data)
    } catch(e) {}
    if(!res.ok) {
      throw new Error(res.data ? `${res.data.code}: ${res.data.message}` : `${res.status}: ${res.statusText}`);
    }
    return res;
  }

  static async submitForm(apiEndpoint, data, options = { headers: {} }) {
    const form = new FormData();
    Object.entries(data).forEach(([k, v]) => {
      form.append(k, v, !k.endsWith('.zip') ? '' : { filename: path.basename(k), contentType: 'application/zip', knownLength: fsPromises.statSync(k).size })
    })
    const res = await this.request(apiEndpoint, { 
      ...options,
      method: 'POST',
      headers: options.headers || {},
      body: form
    });
    return res.data
  }
}

module.exports = Utils;