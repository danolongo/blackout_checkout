import {generateKeyPairSync} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
writeFileSync('.env.relay',JSON.stringify(privateKey.export({format:'jwk'})),{mode:0o600,flag:'wx'});
console.log('Created private relay key in .env.relay. Back it up securely before onboarding registers.');
