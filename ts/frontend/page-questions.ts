import { Assistant, ContradictionError, Matcher } from '../shared/assistant.js';
import { Book, Context } from '../shared/core.js';
import { formatContext } from './formatter.js';
import { katexTypeset } from './katex-typeset.js';
import navigation from './navigation.js';
import { create } from './util.js';

const ADJECTIVES_CONSTRAINTS: { [type: string]: { [adj: string]: boolean[] } } = {
    'scheme': {},
    'morphism': {}
};

function combinations<T>(array: T[], size: number): T[][] {
    const result: T[][] = [];
    function p(tuple: T[], i: number) {
        if (tuple.length === size) {
            result.push(tuple);
            return;
        }
        if (i + 1 > array.length)
            return;
        p(tuple.concat(array[i]), i + 1);
        p(tuple, i + 1);
    }
    p([], 0);
    return result;
}

function product<T>(array: T[], size: number): T[][] {
    if (size == 0) return [[]];
    const results: T[][] = [];
    for (const tuple of product(array, size - 1)) {
        for (const t of array)
            results.push(tuple.concat(t));
    }
    return results;
}

function questions(summary: Book, type: string, constraints: { [adj: string]: boolean[] }): Context[] {
    const adjectives = Object.keys(summary.adjectives[type]);
    const maxAdjectives = 2;

    const assistant = new Assistant(summary);
    const questions: Context[] = []; // contains the original questions
    const questionsDeduced: Context[] = []; // contains the deduced contexts

    const id = 'X'; // dummy name

    // GENERATE QUESTIONS
    for (let n = 1; n <= maxAdjectives; ++n) { // loop over number of adjectives
        for (const adjs of combinations(adjectives, n)) { // loop over all combinations of adjectives
            for (const values of product([true, false], n)) { // loop over all values of the adjectives
                if (adjs.some((adj, i) => (adj in constraints && !constraints[adj].includes(values[i])))) // if some value does not match the constraints, just skip this one
                    continue;
                if (!values.some(v => v)) // we want at least one positive property
                    continue;
                const context = summary.createContextFromType(type, id); // create context for type
                for (let i = 0; i < n; ++i) // assign the adjectives their values
                    context[type][id].adjectives[adjs[i]] = values[i];
                const results = assistant.search(context); // search for examples
                let contradiction = false; // deduce on context, and see if there is a contradiction
                const contextClone = structuredClone(context);
                try { assistant.deduce(contextClone); } catch (err: any) {
                    if (!(err instanceof ContradictionError)) throw err;
                    contradiction = true;
                }
                if (results.length == 0 && !contradiction) { // if there are no results and no contradiction ...
                    questions.push(context); // ... then this is a good question
                    questionsDeduced.push(contextClone);
                }
            }
        }
    }

    // FILTER QUESTIONS (IF A => B, THEN WE MAY AS WELL OMIT B)
    for (let i = 0; i < questions.length; ++i) {
        for (let j = 0; j < questions.length; ++j) {
            if (i == j) continue;
            const A = questionsDeduced[i];
            const B = questions[j]; // use this so that we need to check fewer conditions
            const matcher = new Matcher(summary, B, A);

            if (matcher.match(B[type][id], A[type][id])) { // check if A => B
                questions.splice(j, 1); // remove B
                questionsDeduced.splice(j, 1); // remove B
                --j; // shift j one back
                if (i > j) --i;// shift i one back if i > j
            }
        }
    }

    return questions;
}

function missingProperties(summary: Book): { type: string, id: string, missing: string[] }[] {
    const assistant = new Assistant(summary);
    const results: { type: string, id: string, missing: string[] }[] = [];

    for (const type in summary.examples) {
        if (!(type in summary.adjectives)) continue;
        const allAdjs = Object.keys(summary.adjectives[type]);

        for (const id in summary.examples[type]) {
            const context: Context = {};
            const addToContext = (t: string, eid: string) => {
                if (!(t in context)) context[t] = {};
                if (eid in context[t]) return;
                context[t][eid] = structuredClone(summary.examples[t][eid]);
                for (const key in summary.examples[t][eid].args) {
                    const argType = summary.types[t].parameters[key];
                    addToContext(argType, summary.examples[t][eid].args[key]);
                }
            };
            addToContext(type, id);

            try { assistant.deduce(context); } catch (err) {
                if (!(err instanceof ContradictionError)) throw err;
            }

            const missing = allAdjs.filter(adj => !(adj in context[type][id].adjectives));
            if (missing.length > 0)
                results.push({ type, id, missing });
        }
    }

    results.sort((a, b) => a.missing.length - b.missing.length || a.id.localeCompare(b.id));
    return results;
}

function shuffle<T>(array: T[]): void {
    let index = array.length;
    while (index != 0) {
        const i = Math.floor(Math.random() * index);
        index--;
        [array[index], array[i]] = [array[i], array[index]];
    }
}

function pageOpenQuestions(summary: Book): HTMLElement {
    const container = create('div');
    container.append(create('span', { class: 'title' }, 'Questions'));
    container.append(create('p', {}, 'The questions below could not be answered with \'yes\' by the examples, or with \'no\' using the theorems.'));

    const loading = create('div', { class: 'loading' });
    container.append(loading);

    const table = create('table', { style: 'margin-bottom: 4px;' });
    container.append(table);
    setTimeout(() => {
        table.append(create('tr', {}, create('th', {}, 'Questions')));
        const qs: Context[] = [];
        for (const type in ADJECTIVES_CONSTRAINTS)
            qs.push(...questions(summary, type, ADJECTIVES_CONSTRAINTS[type]));
        console.log(`#questions = ${qs.length}`);
        shuffle(qs);
        let i = 0;
        const maxQuestions = 25;
        for (const question of qs) {
            if (++i > maxQuestions) break;
            table.append(create('tr', {}, [
                create('td', {}, [
                    create('span', {}, [
                        'Does there exist ',
                        formatContext(summary, question),
                        '?'
                    ])
                ])
            ]));
        }
        katexTypeset(table);
        loading.remove();
    }, 0);

    return container;
}

function pageMissingPropertiesTable(summary: Book, type: string, entries: { id: string, missing: string[] }[]): HTMLElement {
    const container = create('div');
    container.append(create('span', { class: 'title' }, `${summary.types[type].name}s`));

    const table = create('table', { style: 'margin-bottom: 4px;' });
    container.append(table);
    table.append(create('tr', {}, [create('th', {}, 'Example'), create('th', {}, 'Missing properties')]));
    for (const { id, missing: adjs } of entries) {
        const adjSpan = create('span');
        adjs.forEach((adj, i) => {
            if (i > 0) adjSpan.append(', ');
            adjSpan.append(navigation.anchorAdjective(type, adj));
        });
        table.append(create('tr', {}, [
            create('td', {}, navigation.anchorExample(type, id)),
            create('td', {}, adjSpan)
        ]));
    }
    katexTypeset(table);
    return container;
}

function pageMissingProperties(summary: Book): HTMLElement {
    const container = create('div');
    container.append(create('span', { class: 'title' }, 'Examples with missing properties'));
    container.append(create('p', {}, 'The following examples have adjectives that could not be determined from the given theorems.'));

    const loading = create('div', { class: 'loading' });
    container.append(loading);

    setTimeout(() => {
        const missing = missingProperties(summary);
        console.log(`#examples with missing properties = ${missing.length}`);
        const byType: { [type: string]: { id: string, missing: string[] }[] } = {};
        for (const { type, id, missing: adjs } of missing) {
            if (!(type in byType)) byType[type] = [];
            byType[type].push({ id, missing: adjs });
        }
        for (const type in byType)
            container.append(pageMissingPropertiesTable(summary, type, byType[type]));
        loading.remove();
    }, 0);

    return container;
}

export function pageQuestions(summary: Book): HTMLElement {
    const page = create('div', { class: 'page page-questions' });
    page.append(pageOpenQuestions(summary));
    page.append(pageMissingProperties(summary));
    return page;
}
