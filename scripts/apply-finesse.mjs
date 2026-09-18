// Run after copying this update into the existing site folder.
// Preserve page content; refresh only theme metadata, legacy CTAs and asset versions.
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const assets=['css/unusual.css','js/studio.js'];
const hashes=Object.fromEntries(assets.map(p=>[p,createHash('sha1').update(readFileSync(join(root,p))).digest('hex').slice(0,10)]));
let count=0;
function update(text){
 return text.replace(/(<meta name="theme-color" content=")[^"]+/g,'$1#eeede5').replaceAll('Get a free site','Websites — £30/month').replaceAll('Want one of these?','Discuss your website');
}
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){if(['node_modules','.git','.github','scripts','supabase','docs'].includes(e.name))continue;const p=join(dir,e.name);if(e.isDirectory()){walk(p);continue;}if(!/\.html?$/.test(e.name))continue;let s=readFileSync(p,'utf8');if(!s.includes('wba-public'))continue;s=update(s);for(const asset of assets){const escaped=asset.replaceAll('.','\\.');s=s.replace(new RegExp('(/'+escaped+')(?:\\?v=[a-f0-9]+)?','g'),'$1?v='+hashes[asset]);}writeFileSync(p,s);count++;}}
walk(root);
const generator=join(root,'scripts/build-feed.mjs');if(existsSync(generator)){let s=update(readFileSync(generator,'utf8'));if(!s.includes("add('css/unusual.css')"))s=s.replace("add('css/studio.css');","add('css/studio.css');\n  add('css/unusual.css');");writeFileSync(generator,s);}
console.log('Updated '+count+' public pages; page copy and backend configuration preserved. Deploy using your existing process.');
