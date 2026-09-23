let wasm_bindgen = (function(exports) {
    let script_src;
    if (typeof document !== 'undefined' && document.currentScript !== null) {
        script_src = new URL(document.currentScript.src, location.href).toString();
    }

    /**
     * A PERSISTENT engine: one `Search` (one transposition table) that lives for a
     * whole game inside the worker, instead of a fresh table per move.
     *
     * Two things this buys that a fresh table per move cannot:
     *
     * * **TT persistence.** The previous move's tree is largely this move's tree
     *   two plies down, so the first iterations of every search come almost free.
     * * **Pondering.** While the human thinks, `ponder_step` searches the position
     *   they are looking at (TT priming, as the JS Caveman does): whatever they
     *   play, the engine's root is a child of the ponder root whose subtree is
     *   already in the table. Slices keep the worker responsive -- the search is
     *   synchronous, so a queued `search` message runs between slices.
     *
     * Repetition history is replaced on every call from the list the client sends,
     * never accumulated (`clear_history`).
     */
    class Engine {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            EngineFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_engine_free(ptr, 0);
        }
        /**
         * @param {number} tt_bits
         */
        constructor(tt_bits) {
            const ret = wasm.engine_new(tt_bits);
            this.__wbg_ptr = ret;
            EngineFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * Forget the previous game (table, killers, history).
         */
        new_game() {
            wasm.engine_new_game(this.__wbg_ptr);
        }
        /**
         * Begin pondering `sfn` (the position the OPPONENT is thinking about).
         * `history_sfns` as for `search`. Returns an error JSON or `{"ok":true}`.
         * @param {string} sfn
         * @param {number} width_scale
         * @param {string[]} history_sfns
         * @param {string} eval_name
         * @param {number} adaptive_p
         * @param {number} adaptive_easy
         * @param {number} adaptive_hard
         * @returns {string}
         */
        ponder_begin(sfn, width_scale, history_sfns, eval_name, adaptive_p, adaptive_easy, adaptive_hard) {
            let deferred4_0;
            let deferred4_1;
            try {
                const ptr0 = passStringToWasm0(sfn, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                const len0 = WASM_VECTOR_LEN;
                const ptr1 = passArrayJsValueToWasm0(history_sfns, wasm.__wbindgen_malloc);
                const len1 = WASM_VECTOR_LEN;
                const ptr2 = passStringToWasm0(eval_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                const len2 = WASM_VECTOR_LEN;
                const ret = wasm.engine_ponder_begin(this.__wbg_ptr, ptr0, len0, width_scale, ptr1, len1, ptr2, len2, adaptive_p, adaptive_easy, adaptive_hard);
                deferred4_0 = ret[0];
                deferred4_1 = ret[1];
                return getStringFromWasm0(ret[0], ret[1]);
            } finally {
                wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
            }
        }
        /**
         * Stop pondering (the table keeps everything it learned).
         */
        ponder_end() {
            wasm.engine_ponder_end(this.__wbg_ptr);
        }
        /**
         * One pondering slice of at most `slice_ms`. Each slice re-drives iterative
         * deepening from depth 1 to at most `max_depth`; with the warm table the
         * already-completed depths cost microseconds, and whatever the cut-off
         * iteration stored stays in the table for the next slice. Returns
         * `{"ok":true,"depth":d,"nodes":n,"done":bool}`; `done` when `max_depth`
         * completed, a decisive score was found, or nothing is being pondered.
         * @param {number} slice_ms
         * @param {number} max_depth
         * @returns {string}
         */
        ponder_step(slice_ms, max_depth) {
            let deferred1_0;
            let deferred1_1;
            try {
                const ret = wasm.engine_ponder_step(this.__wbg_ptr, slice_ms, max_depth);
                deferred1_0 = ret[0];
                deferred1_1 = ret[1];
                return getStringFromWasm0(ret[0], ret[1]);
            } finally {
                wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
            }
        }
        /**
         * The `/api/move` contract and JSON, on the persistent table.
         * @param {string} sfn
         * @param {number} time_ms
         * @param {number} width_scale
         * @param {string[]} history_sfns
         * @param {string} eval_name
         * @param {number} adaptive_p
         * @param {number} adaptive_easy
         * @param {number} adaptive_hard
         * @param {Function | null} [on_depth]
         * @returns {string}
         */
        search(sfn, time_ms, width_scale, history_sfns, eval_name, adaptive_p, adaptive_easy, adaptive_hard, on_depth) {
            let deferred4_0;
            let deferred4_1;
            try {
                const ptr0 = passStringToWasm0(sfn, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                const len0 = WASM_VECTOR_LEN;
                const ptr1 = passArrayJsValueToWasm0(history_sfns, wasm.__wbindgen_malloc);
                const len1 = WASM_VECTOR_LEN;
                const ptr2 = passStringToWasm0(eval_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                const len2 = WASM_VECTOR_LEN;
                const ret = wasm.engine_search(this.__wbg_ptr, ptr0, len0, time_ms, width_scale, ptr1, len1, ptr2, len2, adaptive_p, adaptive_easy, adaptive_hard, isLikeNone(on_depth) ? 0 : addToExternrefTable0(on_depth));
                deferred4_0 = ret[0];
                deferred4_1 = ret[1];
                return getStringFromWasm0(ret[0], ret[1]);
            } finally {
                wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
            }
        }
        /**
         * Slots in use, for the smoke test's "the table survived the move" check.
         * @returns {number}
         */
        tt_filled() {
            const ret = wasm.engine_tt_filled(this.__wbg_ptr);
            return ret >>> 0;
        }
    }
    if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;
    exports.Engine = Engine;

    /**
     * @returns {string}
     */
    function engine_info() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.engine_info();
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    exports.engine_info = engine_info;

    /**
     * Puzzles page: judge the position AFTER the puzzle's mover has played
     * (`sfn` has the opponent to move). `plies` is how many half-moves the mover
     * has left to force the win (2 when the next mover turn must mate, 4 for a
     * mate-in-2 still to come, ...). Returns the verdict and the opponent's reply
     * to play, in the `/api/move` shape:
     *
     * `{"ok":true,"verdict":"mate"|"likely_mate"|"mate_slow"|"escape",
     *   "proven":bool,"mate_in":plies|null,"mate_in_turns":turns|null,
     *   "score_ui":u,"stones":x|null,"depth":d,"nodes":n,
     *   "exhaustive":bool,"actions":[...],"expected_sfn":"..."}`
     *
     * `mate_in` counts plies from this root; `mate_in_turns` the mover's own
     * remaining turns (`plies_to_turns`). `stones` is the opponent-POV
     * `Report::stones` (even offset applied) so the escape text prints the same
     * number the think report would.
     *
     * * `plies == 2`: an EXHAUSTIVE check first (every reply, then every mover
     *   turn) with 40% of the time; `mate` / `escape` from it are proofs, and on
     *   `escape` the refuting reply is the move returned.
     * * Otherwise (or when the exhaustive check ran out of time) the shipped
     *   search from the opponent's side to depth `plies`: a proven mate against
     *   it within `plies` is `mate`; a proven mate that needs more is
     *   `mate_slow`; an unproven mate score is `likely_mate`; anything else is
     *   `escape`. The search's best move is the reply either way.
     * @param {string} sfn
     * @param {number} plies
     * @param {number} time_ms
     * @param {number} tt_bits
     * @returns {string}
     */
    function judge_move(sfn, plies, time_ms, tt_bits) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(sfn, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.judge_move(ptr0, len0, plies, time_ms, tt_bits);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    exports.judge_move = judge_move;

    /**
     * Sanity handle for the loader: confirms the module initialised.
     * Game clock allocation, see `search::move_budget_ms`. Exported for the
     * smoke test's parity check against rust-ai.js's mirror and for callers that
     * prefer the engine's number.
     * @param {number} remaining_ms
     * @param {number} inc_ms
     * @param {number} my_moves_played
     * @returns {number}
     */
    function move_budget_ms(remaining_ms, inc_ms, my_moves_played) {
        const ret = wasm.move_budget_ms(remaining_ms, inc_ms, my_moves_played);
        return ret >>> 0;
    }
    exports.move_budget_ms = move_budget_ms;
    function __wbg_get_imports() {
        const import0 = {
            __proto__: null,
            __wbg___wbindgen_string_get_d154f1e671052120: function(arg0, arg1) {
                const obj = arg1;
                const ret = typeof(obj) === 'string' ? obj : undefined;
                var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                var len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
                getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
            },
            __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
                throw new Error(getStringFromWasm0(arg0, arg1));
            },
            __wbg_call_39f824e18d9d2414: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
                const ret = arg0.call(arg1, arg2, arg3, arg4);
                return ret;
            }, arguments); },
            __wbg_now_8b265300afd5f2b9: function() {
                const ret = Date.now();
                return ret;
            },
            __wbindgen_cast_0000000000000001: function(arg0) {
                // Cast intrinsic for `F64 -> Externref`.
                const ret = arg0;
                return ret;
            },
            __wbindgen_init_externref_table: function() {
                const table = wasm.__wbindgen_externrefs;
                const offset = table.grow(4);
                table.set(0, undefined);
                table.set(offset + 0, undefined);
                table.set(offset + 1, null);
                table.set(offset + 2, true);
                table.set(offset + 3, false);
            },
        };
        return {
            __proto__: null,
            "./sigil_engine_bg.js": import0,
        };
    }

    const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));

    function addToExternrefTable0(obj) {
        const idx = wasm.__externref_table_alloc();
        wasm.__wbindgen_externrefs.set(idx, obj);
        return idx;
    }

    let cachedDataViewMemory0 = null;
    function getDataViewMemory0() {
        if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
            cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
        }
        return cachedDataViewMemory0;
    }

    function getStringFromWasm0(ptr, len) {
        return decodeText(ptr >>> 0, len);
    }

    let cachedUint8ArrayMemory0 = null;
    function getUint8ArrayMemory0() {
        if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
            cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
        }
        return cachedUint8ArrayMemory0;
    }

    function handleError(f, args) {
        try {
            return f.apply(this, args);
        } catch (e) {
            const idx = addToExternrefTable0(e);
            wasm.__wbindgen_exn_store(idx);
        }
    }

    function isLikeNone(x) {
        return x === undefined || x === null;
    }

    function passArrayJsValueToWasm0(array, malloc) {
        const ptr = malloc(array.length * 4, 4) >>> 0;
        for (let i = 0; i < array.length; i++) {
            const add = addToExternrefTable0(array[i]);
            getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
        }
        WASM_VECTOR_LEN = array.length;
        return ptr;
    }

    function passStringToWasm0(arg, malloc, realloc) {
        if (realloc === undefined) {
            const buf = cachedTextEncoder.encode(arg);
            const ptr = malloc(buf.length, 1) >>> 0;
            getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
            WASM_VECTOR_LEN = buf.length;
            return ptr;
        }

        let len = arg.length;
        let ptr = malloc(len, 1) >>> 0;

        const mem = getUint8ArrayMemory0();

        let offset = 0;

        for (; offset < len; offset++) {
            const code = arg.charCodeAt(offset);
            if (code > 0x7F) break;
            mem[ptr + offset] = code;
        }
        if (offset !== len) {
            if (offset !== 0) {
                arg = arg.slice(offset);
            }
            ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
            const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
            const ret = cachedTextEncoder.encodeInto(arg, view);

            offset += ret.written;
            ptr = realloc(ptr, len, offset, 1) >>> 0;
        }

        WASM_VECTOR_LEN = offset;
        return ptr;
    }

    let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    function decodeText(ptr, len) {
        return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
    }

    const cachedTextEncoder = new TextEncoder();

    if (!('encodeInto' in cachedTextEncoder)) {
        cachedTextEncoder.encodeInto = function (arg, view) {
            const buf = cachedTextEncoder.encode(arg);
            view.set(buf);
            return {
                read: arg.length,
                written: buf.length
            };
        };
    }

    let WASM_VECTOR_LEN = 0;

    let wasmModule, wasmInstance, wasm;
    function __wbg_finalize_init(instance, module) {
        wasmInstance = instance;
        wasm = instance.exports;
        wasmModule = module;
        cachedDataViewMemory0 = null;
        cachedUint8ArrayMemory0 = null;
        wasm.__wbindgen_start();
        return wasm;
    }

    async function __wbg_load(module, imports) {
        if (typeof Response === 'function' && module instanceof Response) {
            if (!module.ok) {
                throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
            }

            if (typeof WebAssembly.instantiateStreaming === 'function') {
                try {
                    return await WebAssembly.instantiateStreaming(module, imports);
                } catch (e) {
                    const validResponse = expectedResponseType(module.type);

                    if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                        console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                    } else { throw e; }
                }
            }

            const bytes = await module.arrayBuffer();
            return await WebAssembly.instantiate(bytes, imports);
        } else {
            const instance = await WebAssembly.instantiate(module, imports);

            if (instance instanceof WebAssembly.Instance) {
                return { instance, module };
            } else {
                return instance;
            }
        }

        function expectedResponseType(type) {
            switch (type) {
                case 'basic': case 'cors': case 'default': return true;
            }
            return false;
        }
    }

    function initSync(module) {
        if (wasm !== undefined) return wasm;


        if (module !== undefined) {
            if (Object.getPrototypeOf(module) === Object.prototype) {
                ({module} = module)
            } else {
                console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
            }
        }

        const imports = __wbg_get_imports();
        if (!(module instanceof WebAssembly.Module)) {
            module = new WebAssembly.Module(module);
        }
        const instance = new WebAssembly.Instance(module, imports);
        return __wbg_finalize_init(instance, module);
    }

    async function __wbg_init(module_or_path) {
        if (wasm !== undefined) return wasm;


        if (module_or_path !== undefined) {
            if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
                ({module_or_path} = module_or_path)
            } else {
                console.warn('using deprecated parameters for the initialization function; pass a single object instead')
            }
        }

        if (module_or_path === undefined && script_src !== undefined) {
            module_or_path = script_src.replace(/\.js$/, "_bg.wasm");
        }
        const imports = __wbg_get_imports();

        if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
            module_or_path = fetch(module_or_path);
        }

        const { instance, module } = await __wbg_load(await module_or_path, imports);

        return __wbg_finalize_init(instance, module);
    }

    return Object.assign(__wbg_init, { initSync }, exports);
})({ __proto__: null });
