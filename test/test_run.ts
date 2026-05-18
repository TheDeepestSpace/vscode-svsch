import { runParser } from './helper';
import * as fs from 'fs';

async function main() {
    const code = fs.readFileSync('test/visual/fixtures/var_bit_select_complex.sv', 'utf-8');
    const graph = await runParser('uhdm', 'var_bit_select_complex.sv', code);
    console.log(JSON.stringify(graph, null, 2));
}
main().catch(console.error);
