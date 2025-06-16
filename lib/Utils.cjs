// const formdata = require('form-data');
const fs = require('fs/promises');
const path = require('path');

class Utils {
  get workingDir() {
    return path.join(process.cwd(), 'at-migrate');
  }
  static async loadJson(filepath) {
    return JSON.parse(await fs.readFile(filepath));
  }
  
  static async writeJson(filepath, data) {
    return fs.writeFile(filepath, JSON.stringify(data, null, 2));
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
    // const form = new formdata();
    Object.entries(data).forEach(([k, v]) => {
      form.append(k, v, !k.endsWith('.zip') ? '' : { filename: path.basename(k), contentType: 'application/zip', knownLength: fs.statSync(k).size })
      // form.append(k, v, k.endsWith('.zip') ? path.basename(k) : '')
      // form.append(k, v)
    })
    /*
    console.log(apiEndpoint, { 
      ...options,
      method: 'POST',
      headers: options.headers ?? {}
    });
    */
    const res = await this.request(apiEndpoint, { 
      ...options,
      method: 'POST',
      headers: options.headers || {},
      body: form
      // headers: { ...form.getHeaders(), ...options.headers ?? {} },
      // body: form.getBuffer()
    });
    return res.data
  }
}

module.exports = Utils;