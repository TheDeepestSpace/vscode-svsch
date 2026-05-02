import { runParser } from './helper';
import * as fs from 'fs';

async function main() {
    const code = fs.readFileSync('test/fixtures/bus_comp.sv', 'utf-8');
    const graph = await runParser('uhdm', 'bus_comp.sv', code);
    console.log(JSON.stringify(graph, null, 2));
}
main().catch(console.error);
