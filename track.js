const async = require("async");
const uuid = require("uuid");
const express = require('express')
const app = express()
const port = 3000

// Stolen directly from async.autoInject.
const FN_ARGS = /^(?:async\s+)?(?:function)?\s*\w*\s*\(\s*([^)]+)\s*\)(?:\s*{)/;
const ARROW_FN_ARGS = /^(?:async\s+)?\(?\s*([^)=]+)\s*\)?(?:\s*=>)/;
const FN_ARG_SPLIT = /,/;
const FN_ARG = /(=.+)?(\s*)$/;
const STRIP_COMMENTS = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg;

function isAsync(fn) {
    return fn[Symbol.toStringTag] === 'AsyncFunction';
}

function wrapAsync(asyncFn) {
    if (typeof asyncFn !== 'function') throw new Error('expected a function')
    return isAsync(asyncFn) ? async.asyncify(asyncFn) : asyncFn;
}

function parseParams(func) {
    const src = func.toString().replace(STRIP_COMMENTS, '');
    let match = src.match(FN_ARGS)
    if (!match) {
        match = src.match(ARROW_FN_ARGS);
    }
    if (!match) throw new Error('could not parse args in autoInject\nSource:\n' + src)
    let [, args] = match
    return args
        .replace(/\s/g, '')
        .split(FN_ARG_SPLIT)
        .map((arg) => arg.replace(FN_ARG, '').trim());
}

/**
 */
function autoTrack(tasks, callback, tracker) {
    var blackhole = function() {};
    tracker.reportStart = tracker.reportStart || blackhole;
    tracker.reportError = tracker.reportError || blackhole;
    tracker.reportReturn = tracker.reportReturn || blackhole;

    var newTasks = {};

    Object.keys(tasks).forEach(key => {
        var taskFn = tasks[key]
        var params;
        var fnIsAsync = isAsync(taskFn);
        var hasNoDeps =
            (!fnIsAsync && taskFn.length === 1) ||
            (fnIsAsync && taskFn.length === 0);

        var taskSpec = null;

        if (Array.isArray(taskFn)) {
            params = [...taskFn];
            taskFn = params.pop();
            taskSpec = params.concat(params.length > 0 ? newTask : taskFn);
        } else if (hasNoDeps) {
            taskSpec = newTask0;
        } else {
            params = parseParams(taskFn);
            if ((taskFn.length === 0 && !fnIsAsync) && params.length === 0) {
                throw new Error("autoTrack task functions require explicit parameters.");
            }
            // remove callback param
            if (!fnIsAsync) params.pop();
            taskSpec = params.concat(newTask);
        }
        newTasks[key] = taskSpec;

        function trackingCallback(taskCb) {
            return function(err, result) {
                if (err) {
                    tracker.reportError(key, err);
                } else {
                    tracker.reportReturn(key, result);
                }
                taskCb(err, result);
            };
        }
        function newTask(results, taskCb) {
            var newArgs = params.map(name => results[name])
            tracker.reportStart(key, [...newArgs]);
            newArgs.push(trackingCallback(taskCb));
            wrapAsync(taskFn)(...newArgs);
        }

        function newTask0(taskCb) {
            tracker.reportStart(key, []);
            wrapAsync(taskFn)(trackingCallback(taskCb));
        }
    });

    var graph = {
        nodes: [],
        links: [],
    };
    var idxMap = {};

    for (var key in newTasks) {
        var id = graph.nodes.length;
        idxMap[key] = id;
        graph.nodes.push({
            name: key,
            group: 1,
            class: "notrun"
        });
    }

    for (var key in newTasks) {
        var spec = newTasks[key];
        var id = idxMap[key];
        if (Array.isArray(spec)) {
            for (var i = 0; i < spec.length - 1; i++) {
                graph.links.push({
                    source: id,
                    target: idxMap[spec[i]],
                    value: 1,
                    type: "depends"
                });
            }
        }
    }

    tracker.setGraph(graph);

    // console.log(newTasks, callback);
    return async.auto(newTasks, callback);
}

/**
 * @constructor
 */
function MultiTracker() {
    this.workflows = {};
}

MultiTracker.prototype.controller = function() {
    return (req, res) => {
        res.json(this.workflows);
    };
};

function getTimeUTC() {
    return new Date().toISOString()
}

MultiTracker.prototype.newTracker = function(reqId, context) {
    var wf = {};
    var id = uuid.v4();
    this.workflows[id] = wf;

    wf.reqId = reqId;
    wf.time = getTimeUTC();
    wf.context = context;
    wf.inputs = {};
    wf.results = {};
    wf.errors = {};
    wf.startTime = {}
    wf.endTime = {}

    function simpleReport(key, tag) {
        for (var i = 0; i < wf.graph.nodes.length; i++) {
            var node = wf.graph.nodes[i];
            if (node.name == key) {
                node.class = tag;
            }
        }
    }

    return {
        setGraph: function(graph) {
            wf.graph = graph;
        },
        reportStart: function(key, inputs) {
            simpleReport(key, "start");
            wf.inputs[key] = inputs;
            wf.startTime[key] = getTimeUTC();
        },
        reportReturn: function(key, result) {
            simpleReport(key, "return");
            wf.results[key] = result;
            wf.endTime[key] = getTimeUTC();
        },
        reportError: function(key, error) {
            simpleReport(key, "error");
            wf.errors[key] = error.message;
            wf.endTime[key] = getTimeUTC();
        }
    };
}

function main() {
    var mt = new MultiTracker();


    app.use(express.static('public'))

    app.get('/track.json', mt.controller());

    app.get('/dostuff', (req, res) => {
        const requestId = uuid.v4();
        var tracker = mt.newTracker(requestId, req.path);

        autoTrack({
            task1: function(callback) {
                setTimeout(() => {
                    callback(null, 1);
                }, 100);
            },
            task2: function(task1, callback) {
                if  (task1 == 1) {
                    setTimeout(() => {
                        callback(null, 2);
                    }, 200);
                } else {
                    return callback(new Error("Invalid inputs"));
                }
            },
            task3: function(task1, task2, callback) {
                if (task1 == 1 && task2 == 2 && Math.random() < .6) {
                    setTimeout(() => {
                        callback(null, 3);
                    }, 300);
                } else {
                    return callback(new Error("Invalid inputs or sporadic error"));
                }
            },
            task4: function(callback) {
                callback(null, 4);
            },
            task5: function(task3, task4, callback) {
                if (task3 == 3 && task4 == 4) {
                    return callback(null, 5);
                } else {
                    return callback(new Error("Invalid inputs"));
                }
            }
        }, function(err, results) {
            res.setHeader('RequestId', requestId);
            if (err) {
                console.warn(err); 
                res.status(500).send(err.message);
            } else {
                res.send('Hello, world!');
                console.log(JSON.stringify(results));
            }
        }, tracker);    
    })

    app.listen(port, () => console.log(`Example app listening at http://localhost:${port}`))
}

main();
