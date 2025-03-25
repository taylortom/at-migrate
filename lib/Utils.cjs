const formdata = require('form-data');
const fs = require('fs/promises');

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
    options.headers = Object.assign({ 'Authorization': `Bearer ${options.authToken}`}, options.headers);
    
    const res = await fetch(`${this.apiUrl}/${endpoint}`, options);
    res.data = await res.json();
    
    if(!res.ok) {
      throw new Error(`${res.data.code}: ${res.data.message}`);
    }
    return res;
  }

  static async submitForm(apiEndpoint, data, options = { headers: {} }) {
    const form = new formdata();
    Object.entries(data).forEach(([K, v]) => form.append(k, v))
      
    const res = await this.request(apiEndpoint, { 
      method: 'POST',
      headers: { ...form.getHeaders(), ...options.headers ?? {} },
      body: form.getBuffer()
    });

    return res.data
  }
}

module.exports = Utils;