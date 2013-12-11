
Spacebars = {};

var makeStacheTagStartRegex = function (r) {
  return new RegExp(r.source + /(?![{>!#/])/.source,
                    r.ignoreCase ? 'i' : '');
};

var prettyOffset = function (code, pos) {
  var codeUpToPos = code.substring(0, pos);
  var startOfLine = codeUpToPos.lastIndexOf('\n') + 1;
  var indexInLine = pos - startOfLine; // 0-based
  var lineNum = codeUpToPos.replace(/[^\n]+/g, '').length + 1; // 1-based
  return "line " + lineNum + ", offset " + indexInLine;
};

var starts = {
  ELSE: makeStacheTagStartRegex(/^\{\{\s*else(?=[\s}])/i),
  DOUBLE: makeStacheTagStartRegex(/^\{\{\s*(?!\s)/),
  TRIPLE: makeStacheTagStartRegex(/^\{\{\{\s*(?!\s)/),
  COMMENT: makeStacheTagStartRegex(/^\{\{\s*!/),
  INCLUSION: makeStacheTagStartRegex(/^\{\{\s*>\s*(?!\s)/),
  BLOCKOPEN: makeStacheTagStartRegex(/^\{\{\s*#\s*(?!\s)/),
  BLOCKCLOSE: makeStacheTagStartRegex(/^\{\{\s*\/\s*(?!\s)/)
};

var ends = {
  DOUBLE: /^\s*\}\}/,
  TRIPLE: /^\s*\}\}\}/
};

Spacebars.starts = starts;

// Parse a tag at `pos` in `inputString`.  Succeeds or errors.
Spacebars.parseStacheTag = function (inputString, pos, options) {
  pos = pos || 0;
  var startPos = pos;
  var str = inputString.slice(pos);

  var lexer = new JSLexer(inputString);

  var advance = function (amount) {
    str = str.slice(amount);
    pos += amount;
  };

  var run = function (regex) {
    // regex is assumed to start with `^`
    var result = regex.exec(str);
    if (! result)
      return null;
    var ret = result[0];
    advance(ret.length);
    return ret;
  };

  var scanToken = function () {
    lexer.divisionPermitted = false;
    lexer.pos = pos;
    return lexer.next();
  };

  var scanIdentifier = function (isFirstInPath) {
    var tok = scanToken();
    // We don't care about overlap with JS keywords,
    // but accept "true", "false", and "null" as identifiers
    // only if not isFirstInPath.
    if (! (tok.type() === 'IDENTIFIER' ||
           tok.type() === 'KEYWORD' ||
           ((! isFirstInPath) && (tok.type() === 'BOOLEAN' ||
                                  tok.type() === 'NULL')))) {
      expected('IDENTIFIER');
    }
    var text = tok.text();
    advance(text.length);
    return text;
  };

  //var scanDottedIdentifier = function () {
  //  var name = scanIdentifier();
  //  while (run(/^\./))
  //    name += '.' + scanIdentifier();
  //  return name;
  //};

  var scanPath = function () {
    var segments = [];

    // handle initial `.`, `..`, `./`, `../`, `../..`, `../../`, etc
    var dots;
    if ((dots = run(/^[\.\/]+/))) {
      var ancestorStr = '.'; // eg `../../..` maps to `....`
      var endsWithSlash = /\/$/.test(dots);

      if (endsWithSlash)
        dots = dots.slice(0, -1);

      _.each(dots.split('/'), function(dotClause, index) {
        if (index === 0) {
          if (dotClause !== '.' && dotClause !== '..')
            expected("`.`, `..`, `./` or `../`");
        } else {
          if (dotClause !== '..')
            expected("`..` or `../`");
        }

        if (dotClause === '..')
          ancestorStr += '.';
      });

      segments.push(ancestorStr);

      if (!endsWithSlash)
        return segments;
    }

    while (true) {
      // scan a path segment

      if (run(/^\[/)) {
        var seg = run(/^[\s\S]*?\]/);
        if (! seg)
          error("Unterminated path segment");
        seg = seg.slice(0, -1);
        if (! seg && ! segments.length)
          error("Path can't start with empty string");
        segments.push(seg);
      } else {
        var id = scanIdentifier(! segments.length);
        if (id === 'this' && ! segments.length) {
          // initial `this`
          segments.push('.');
        } else {
          segments.push(id);
        }
      }

      var sep = run(/^[\.\/]/);
      if (! sep)
        break;
    }

    return segments;
  };

  // scan an argument; succeeds or errors
  var scanArg = function (notKeyword) {
    // all args have `type` and possibly `key`
    var tok = scanToken();
    var tokType = tok.type();
    var text = tok.text();

    if (/^[\.\[]/.test(str) && tokType !== 'NUMBER')
      return ['PATH', scanPath()];

    if (tokType === 'PUNCTUATION' && text === '-') {
      // unary minus
      advance(text.length);
      var numberTok = scanToken();
      if (numberTok.type() !== 'NUMBER')
        expected('identifier, number, string, boolean, or null');
      advance(numberTok.text().length);
      return ['NUMBER', -Number(numberTok.text())];
    }

    if (tokType === 'BOOLEAN') {
      advance(text.length);
      return ['BOOLEAN', tok.text() === 'true'];
    } else if (tokType === 'NULL') {
      advance(text.length);
      return ['NULL', null];
    } else if (tokType === 'NUMBER') {
      advance(text.length);
      return ['NUMBER', Number(tok.text())];
    } else if (tokType === 'STRING') {
      advance(text.length);
      // single quote to double quote
      if (text.slice(0, 1) === "'")
        text = '"' + text.slice(1, -1) + '"';
      // replace line continuations with `\n`
      text = text.replace(/[\r\n\u000A\u000D\u2028\u2029]/g, 'n');
      return ['STRING', JSON.parse(text)];
    } else if (tokType === 'IDENTIFIER' || tokType === 'KEYWORD') {
      if ((! notKeyword) &&
          /^\s*=/.test(str.slice(text.length))) {
        // it's a keyword argument!
        advance(text.length);
        run(/^\s*=\s*/);
        // recurse to scan value, disallowing a second `=`.
        var arg = scanArg(true);
        arg.push(text); // add third element for key
        return arg;
      }
      return ['PATH', scanPath()];
    } else {
      expected('identifier, number, string, boolean, or null');
    }
  };

  var type;

  var error = function (msg) {
    msg = msg + " at " + prettyOffset(inputString, pos);
    if (options && options.sourceName)
      msg += " in " + options.sourceName;
    throw new Error(msg);
  };
  var expected = function (what) {
    error('Expected ' + what + ', found "' + str.slice(0,5) + '"');
  };

  // must do ELSE first; order of others doesn't matter

  if (run(starts.ELSE)) type = 'ELSE';
  else if (run(starts.DOUBLE)) type = 'DOUBLE';
  else if (run(starts.TRIPLE)) type = 'TRIPLE';
  else if (run(starts.COMMENT)) type = 'COMMENT';
  else if (run(starts.INCLUSION)) type = 'INCLUSION';
  else if (run(starts.BLOCKOPEN)) type = 'BLOCKOPEN';
  else if (run(starts.BLOCKCLOSE)) type = 'BLOCKCLOSE';
  else
    error('Unknown stache tag starting with "' + str.slice(0,5) + '"');

  var tag = { type: type };

  if (type === 'COMMENT') {
    var result = run(/^[\s\S]*?\}\}/);
    if (! result)
      error("Unclosed comment");
    tag.value = result.slice(0, -2);
  } else if (type === 'BLOCKCLOSE') {
    tag.path = scanPath();
    if (! run(ends.DOUBLE))
      expected('`}}`');
  } else if (type === 'ELSE') {
    if (! run(ends.DOUBLE))
      expected('`}}`');
  } else {
    // DOUBLE, TRIPLE, BLOCKOPEN, INCLUSION
    tag.path = scanPath();
    tag.args = [];
    while (true) {
      run(/^\s*/);
      if (type === 'TRIPLE') {
        if (run(ends.TRIPLE))
          break;
        else if (str.charAt(0) === '}')
          expected('`}}}`');
      } else {
        if (run(ends.DOUBLE))
          break;
        else if (str.charAt(0) === '}')
          expected('`}}`');
      }
      tag.args.push(scanArg());
      if (run(/^(?=[\s}])/) !== '')
        expected('space');
    }
  }

  var checkTag = function (tag) {
    if (tag.type === 'INCLUSION') {
      // throw error on >1 positional arguments
      var numPosArgs = 0;
      var args = tag.args;
      for (var i = 0; i < args.length; i++)
        if (args[i].length === 2)
          numPosArgs++;
      if (numPosArgs > 1)
        error("Only one positional argument is allowed here");
    }
  };

  checkTag(tag);

  tag.charPos = startPos;
  tag.charLength = pos - startPos;
  return tag;
};

var makeObjectLiteral = function (obj) {
  var parts = [];
  for (var k in obj)
    parts.push(toObjectLiteralKey(k) + ': ' + obj[k]);
  return '{' + parts.join(', ') + '}';
};


// `Spacebars.dot(foo, "bar", "baz")` performs a special kind
// of `foo.bar.baz` that allows safe indexing of `null` and
// indexing of functions (which calls the function).  If the
// result is a function, it is always a bound function (e.g.
// a wrapped version of `baz` that always uses `foo.bar` as
// `this`).
//
// In `Spacebars.dot(foo, "bar")`, `foo` is assumed to be either
// a non-function value or a "fully-bound" function wrapping a value,
// where fully-bound means it takes no arguments and ignores `this`.
//
// `Spacebars.dot(foo, "bar")` performs the following steps:
//
// * If `foo` is falsy, return `foo`.
//
// * If `foo` is a function, call it (set `foo` to `foo()`).
//
// * If `foo` is falsy now, return `foo`.
//
// * Return `foo.bar`, binding it to `foo` if it's a function.
Spacebars.dot = function (value, id1/*, id2, ...*/) {
  if (arguments.length > 2) {
    // Note: doing this recursively is probably less efficient than
    // doing it in an iterative loop.
    var argsForRecurse = [];
    argsForRecurse.push(Spacebars.dot(value, id1));
    argsForRecurse.push.apply(argsForRecurse,
                              Array.prototype.slice.call(arguments, 2));
    return Spacebars.dot.apply(null, argsForRecurse);
  }

  if (typeof value === 'function')
    value = value();

  if (! value)
    return value; // falsy, don't index, pass through

  var result = value[id1];
  if (typeof result !== 'function')
    return result;
  // `value[id1]` (or `value()[id1]`) is a function.
  // Bind it so that when called, `value` will be placed in `this`.
  return function (/*arguments*/) {
    return result.apply(value, arguments);
  };
};


//////////////////////////////////////////////////

Spacebars.parse = function (input) {
  // This implementation of `getSpecialTag` looks for "{{" and if it
  // finds it, it will parse a stache tag or fail fatally trying.
  // The object it returns is opaque to the tokenizer/parser and can
  // be anything we want.
  //
  // Parsing a block tag parses its contents and end tag too!
  var getSpecialTag = function (scanner, position) {
    if (! (scanner.peek() === '{' && // one-char peek is just an optimization
           scanner.rest().slice(0, 2) === '{{'))
      return null;

    // `parseStacheTag` will succeed or die trying.
    //
    // TODO: make `parseStacheTag` use the same `scanner`, and `scanner.fatal`
    // for errors, which should be made to still have nice line numbers.
    var stache = Spacebars.parseStacheTag(scanner.input, scanner.pos);
    // kill any `args: []` cluttering up the object
    if (stache.args && ! stache.args.length)
      delete stache.args;

    if (stache.type === 'ELSE')
      scanner.fatal("Found unexpected {{else}}}");
    else if (stache.type === 'BLOCKCLOSE')
      scanner.fatal("Found unexpected closing stache tag");

    scanner.pos += stache.charLength;
    // TODO: Change `parseStacheTag` to not generate these
    delete stache.charLength;
    delete stache.charPos;

    if (stache.type === 'COMMENT') {
      return null; // consume the tag from the input but emit no Special
    } else if (stache.type === 'BLOCKOPEN') {
      var blockName = stache.path.join(','); // for comparisons, errors

      var textMode = null;
      if (position === HTML.TEMPLATE_TAG_POSITION.IN_RCDATA) {
        textMode = HTML.TEXTMODE.RCDATA;
      }
      var parserOptions = {
        getSpecialTag: getSpecialTag,
        shouldStop: isAtBlockCloseOrElse,
        textMode: textMode
      };
      stache.content = HTML.parseFragment(scanner, parserOptions);

      if (scanner.rest().slice(0, 2) !== '{{')
        scanner.fatal("Expected {{else}} or block close for " + blockName);

      var stache2 = Spacebars.parseStacheTag(scanner.input, scanner.pos);

      if (stache2.type === 'ELSE') {
        scanner.pos += stache2.charLength;
        stache.elseContent = HTML.parseFragment(scanner, parserOptions);

        if (scanner.rest().slice(0, 2) !== '{{')
          scanner.fatal("Expected block close for " + blockName);

        stache2 = Spacebars.parseStacheTag(scanner.input, scanner.pos);
      }

      if (stache2.type === 'BLOCKCLOSE') {
        var blockName2 = stache2.path.join(',');
        if (blockName !== blockName2)
          scanner.fatal('Expected tag to close ' + blockName + ', found ' +
                        + blockName2);
        scanner.pos += stache2.charLength;
      } else {
        scanner.fatal('Expected tag to close ' + blockName + ', found ' +
                      stache2.type);
      }
    }

    return stache;
  };

  var isAtBlockCloseOrElse = function (scanner) {
    // we could just call parseStacheTag, but this function is called
    // for every token in the input stream, so we add some shortcuts.
    var rest, type;
    return (scanner.peek() === '{' &&
            (rest = scanner.rest()).slice(0, 2) === '{{' &&
            /^\{\{\s*(\/|else\b)/.test(rest) &&
            (type = Spacebars.parseStacheTag(scanner.input,
                                             scanner.pos).type) &&
            (type === 'BLOCKCLOSE' || type === 'ELSE'));
  };

  var tree = HTML.parseFragment(input, { getSpecialTag: getSpecialTag });

  return tree;
};

var optimize = function (tree) {

  var pushRawHTML = function (array, html) {
    var N = array.length;
    if (N > 0 && (array[N-1] instanceof HTML.Raw)) {
      array[N-1] = HTML.Raw(array[N-1].value + html);
    } else {
      array.push(HTML.Raw(html));
    }
  };

  var isPureChars = function (html) {
    return (html.indexOf('&') < 0 && html.indexOf('<') < 0);
  };

  var optimizeArrayParts = function (array, optimizePartsFunc, forceOptimize) {
    var result = null;
    if (forceOptimize)
      result = [];
    for (var i = 0, N = array.length; i < N; i++) {
      var part = optimizePartsFunc(array[i]);
      if (part !== null) {
        // something special found
        if (result === null) {
          // This is our first special item.  Stringify the other parts.
          result = [];
          for (var j = 0; j < i; j++)
            pushRawHTML(result, HTML.toHTML(array[j]));
        }
        result.push(part);
      } else {
        // just plain HTML found
        if (result !== null) {
          // we've already found something special, so convert this to Raw
          pushRawHTML(result, HTML.toHTML(array[i]));
        }
      }
    }
    if (result !== null) {
      // clean up unnecessary HTML.Raw wrappers around pure character data
      for (var j = 0; j < result.length; j++) {
        if ((result[j] instanceof HTML.Raw) &&
            isPureChars(result[j].value))
          // replace HTML.Raw with simple string
          result[j] = result[j].value;
      }
    }
    return result;
  };

  var doesAttributeValueHaveSpecials = function (v) {
    if (v instanceof HTML.Special)
      return true;
    if (typeof v === 'function')
      return true;

    if (v instanceof Array) {
      for (var i = 0; i < v.length; i++)
        if (doesAttributeValueHaveSpecials(v[i]))
          return true;
      return false;
    }

    return false;
  };

  var optimizeParts = function (node) {
    // If we have nothing special going on, returns `null` (so that the
    // parent can optimize).  Otherwise returns a replacement for `node`
    // with optimized parts.
    if ((node == null) || (typeof node === 'string') ||
        (node instanceof HTML.CharRef) || (node instanceof HTML.Comment) ||
        (node instanceof HTML.Raw)) {
      // not special; let parent decide how whether to optimize
      return null;
    } else if (node instanceof HTML.Tag) {

      if (node.tagName === 'TEXTAREA') {
        // optimizing into a TEXTAREA's RCDATA would require being a little
        // more clever.
        return node;
      }

      var mustOptimize = false;

      if (node.attrs) {
        var attrs = node.attrs;
        for (var k in attrs) {
          if (doesAttributeValueHaveSpecials(attrs[k])) {
            mustOptimize = true;
            break;
          }
        }
      }

      var newChildren = optimizeArrayParts(node.children, optimizeParts, mustOptimize);

      if (newChildren === null)
        return null;

      var newTag = HTML.getTag(node.tagName).apply(null, newChildren);
      newTag.attrs = node.attrs;

      return newTag;

    } else if (node instanceof Array) {
      return optimizeArrayParts(node, optimizeParts);
    } else {
      return node;
    }
  };

  var optTree = optimizeParts(tree);
  if (optTree !== null)
    // tree was optimized in parts
    return optTree;

  optTree = HTML.Raw(HTML.toHTML(tree));

  if (isPureChars(optTree.value))
    return optTree.value;

  return optTree;
};

var builtInComponents = {
  'content': '__content',
  'elseContent': '__elseContent',
  'if': 'UI.If',
  'unless': 'UI.Unless',
  'with': 'UI.With',
  'each': 'UI.Each'
};

var replaceSpecials = function (node) {
  if (node instanceof HTML.Tag) {
    // potential optimization: don't always create a new tag
    var newChildren = _.map(node.children, replaceSpecials);
    var newTag = HTML.getTag(node.tagName).apply(null, newChildren);
    newTag.attrs = Spacebars._handleSpecialAttributes(node.attrs);
    return newTag;
  } else if (node instanceof Array) {
    return _.map(node, replaceSpecials);
  } else if (node instanceof HTML.Special) {
    var tag = node.value;
    if (tag.type === 'DOUBLE') {
      return HTML.EmitCode('function () { return ' +
                           codeGenMustache(tag) + '; }');
    } else if (tag.type === 'TRIPLE') {
      return HTML.EmitCode('function () { return Spacebars.makeRaw(' +
                           codeGenMustache(tag) + '); }');
    } else if (tag.type === 'INCLUSION' || tag.type === 'BLOCKOPEN') {
      var path = tag.path;
      var compCode = codeGenPath(path);

      if (path.length === 1) {
        var compName = path[0];
        if (builtInComponents.hasOwnProperty(compName)) {
          compCode = builtInComponents[compName];
        } else {
          compCode = ('(Template[' + toJSLiteral(path[0]) +
                      '] || ' + compCode + ')');
        }
      }

      var includeArgs = codeGenInclusionArgs(tag);

      return HTML.EmitCode(
        'function () { return Spacebars.include(' + compCode +
          (includeArgs.length ? ', ' + includeArgs.join(', ') : '') +
          '); }');
    } else {
      throw new Error("Unexpected template tag type: " + tag.type);
    }
  } else {
    return node;
  }
};

var codeGenInclusionArgs = function (tag) {
  var args = null;
  var posArgs = [];

  if ('content' in tag) {
    args = (args || {});
    args.__content = (
      'UI.block(' + Spacebars.codeGen(tag.content) + ')');
  }
  if ('elseContent' in tag) {
    args = (args || {});
    args.__elseContent = (
      'UI.block(' + Spacebars.codeGen(tag.elseContent) + ')');
  }

  // precalculate the number of positional args
  var numPosArgs = 0;
  _.each(tag.args, function (arg) {
    if (arg.length === 2)
      numPosArgs++;
  });

  _.each(tag.args, function (arg) {
    var argType = arg[0];
    var argValue = arg[1];

    var isKeyword = (arg.length > 2);

    var argCode;
    switch (argType) {
    case 'STRING':
    case 'NUMBER':
    case 'BOOLEAN':
    case 'NULL':
      argCode = toJSLiteral(argValue);
      break;
    case 'PATH':
      var path = argValue;
      argCode = codeGenPath(path);
      // a single-segment path will compile to something like
      // `self.lookup("foo")` which never establishes any dependencies,
      // while `Spacebars.dot(self.lookup("foo"), "bar")` may establish
      // dependencies.
      //
      // In the multi-positional-arg construct, don't wrap pos args here.
      if (! ((path.length === 1) || (numPosArgs > 1)))
        argCode = 'function () { return Spacebars.call(' + argCode + '); }';
      break;
    default:
      // can't get here
      throw new Error("Unexpected arg type: " + argType);
    }

    if (isKeyword) {
      // keyword argument (represented as [type, value, name])
      var name = arg[2];
      args = (args || {});
      args[name] = argCode;
    } else {
      // positional argument
      posArgs.push(argCode);
    }
  });

  if (posArgs.length === 1) {
    args = (args || {});
    args.data = posArgs[0];
  } else if (posArgs.length > 1) {
    // only allowed for block helper (which has already been
    // checked at parse time); call first
    // argument as a function on the others
    args = (args || {});
    args.data = 'function () { return Spacebars.call(' + posArgs.join(', ') + '); }';
  }

  if (args)
    return [makeObjectLiteral(args)];

  return [];
};

Spacebars.include = function (kindOrFunc, args) {
  args = args || {};
  if (typeof kindOrFunc === 'function') {
    // function block helper
    var func = kindOrFunc;

    var hash = {};
    // Call arguments if they are functions.  This may cause
    // reactive dependencies!
    for (var k in args) {
      if (k !== 'data') {
        var v = args[k];
        hash[k] = (typeof v === 'function' ? v() : v);
      }
    }

    var result;
    if ('data' in args) {
      var data = args.data;
      data = (typeof data === 'function' ? data() : data);
      result = func(data, { hash: hash });
    } else {
      result = func({ hash: hash });
    }
    // In `{{#foo}}...{{/foo}}`, if `foo` is a function that
    // returns a component, attach __content and __elseContent
    // to it.
    if (UI.isComponent(result) &&
        (('__content' in args) || ('__elseContent' in args))) {
      var extra = {};
      if ('__content' in args)
        extra.__content = args.__content;
      if ('__elseContent' in args)
        extra.__elseContent = args.__elseContent;
      result = result.extend(extra);
    }
    return result;
  } else {
    // Component
    var kind = kindOrFunc;
    if (! UI.isComponent(kind))
      throw new Error("Expected template, found: " + kind);

    // Note that there are no reactive dependencies established here.
    if (args) {
      var emboxedArgs = {};
      for (var k in args) {
        if (k === '__content' || k === '__elseContent')
          emboxedArgs[k] = args[k];
        else
          emboxedArgs[k] = UI.emboxValue(args[k]);
      }

      return kind.extend(emboxedArgs);
    } else {
      return kind;
    }
  }
};

// Input: Attribute dictionary, or null.  Attribute values may have `Special`
// nodes representing template tags.  In addition, the synthetic attribute
// `$specials` may be present and contain an array of `Special` nodes
// representing template tags in the attribute name position (i.e. "dynamic
// attributes" like `<div {{attrs}}>`).
//
// Output: If there are no Specials in the attribute values and no $specials,
// returns the input.  Otherwise, converts any `Special` nodes to functions
// and converts `$specials` to `$dynamic`.
//
// (exposed for testing)
Spacebars._handleSpecialAttributes = function (oldAttrs) {
  if (! oldAttrs)
    return oldAttrs;

  // array of Special nodes wrapping template tags
  var dynamics = null;
  if (oldAttrs.$specials && oldAttrs.$specials.length)
    dynamics = oldAttrs.$specials;

  var foundSpecials = false;

  // Runs on an attribute value, or part of an attribute value.
  // If Specials are found, converts them to EmitCode with
  // the appropriate generated code.  Otherwise, returns the
  // input.
  //
  // If specials are found, sets `foundSpecials` to true.
  var convertSpecialToEmitCode = function (v) {
    if (v instanceof HTML.Special) {
      foundSpecials = true;
      return HTML.EmitCode('function () { return ' +
                           codeGenMustache(v.value) + '; }');
    } else if (v instanceof Array) {
      return _.map(v, convertSpecialToEmitCode);
    } else {
      return v;
    }
  };

  var newAttrs = null;
  _.each(oldAttrs, function (value, name) {
    if (name.charAt(0) !== '$') {
      if (! newAttrs)
        newAttrs = {};
      newAttrs[name] = convertSpecialToEmitCode(value);
    }
  });

  if ((! dynamics) && (! foundSpecials))
    return oldAttrs;

  if (dynamics) {
    if (! newAttrs)
      newAttrs = {};
    newAttrs.$dynamic = _.map(dynamics, function (special) {
      var tag = special.value;
      return HTML.EmitCode('function () { return ' +
                           codeGenMustache(tag, 'attrMustache') + '; }');
    });
  }

  return newAttrs;
};

// Executes `{{foo bar baz}}` when called on `(foo, bar, baz)`.
// If `bar` and `baz` are functions, they are called before
// `foo` is called on them.
//
// This is the shared part of Spacebars.mustache and
// Spacebars.attrMustache, which differ in how they post-process the
// result.
Spacebars.mustacheImpl = function (value/*, args*/) {
  var args = arguments;
  // if we have any arguments (pos or kw), add an options argument
  // if there isn't one.
  if (args.length > 1) {
    var kw = args[args.length - 1];
    if (! (kw instanceof Spacebars.kw)) {
      kw = Spacebars.kw();
      // clone arguments into an actual array, then push
      // the empty kw object.
      args = Array.prototype.slice.call(arguments);
      args.push(kw);
    } else {
      // For each keyword arg, call it if it's a function
      var newHash = {};
      for (var k in kw.hash) {
        var v = kw.hash[k];
        newHash[k] = (typeof v === 'function' ? v() : v);
      }
      args[args.length - 1] = Spacebars.kw(newHash);
    }
  }

  return Spacebars.call.apply(null, args);
};

Spacebars.mustache = function (value/*, args*/) {
  var result = Spacebars.mustacheImpl.apply(null, arguments);

  if (result instanceof Handlebars.SafeString)
    return HTML.Raw(result.toString());
  else
    // map `null` and `undefined` to "", stringify anything else
    // (e.g. strings, booleans, numbers including 0).
    return String(result == null ? '' : result);
};

Spacebars.attrMustache = function (value/*, args*/) {
  var result = Spacebars.mustacheImpl.apply(null, arguments);

  if (result == null || result === '') {
    return null;
  } else if (typeof result === 'object') {
    return result;
  } else if (typeof result === 'string' && HTML.isValidAttributeName(result)) {
    var obj = {};
    obj[result] = '';
    return obj;
  } else {
    throw new Error("Expected valid attribute name, '', null, or object");
  }
};

// Idempotently wrap in `HTML.Raw`.
//
// Called on the return value from `Spacebars.mustache` in case the
// template uses triple-stache (`{{{foo bar baz}}}`).
Spacebars.makeRaw = function (value) {
  if (value instanceof HTML.Raw)
    return value;
  else
    return HTML.Raw(value);
};

// If `value` is a function, called it on the `args`, after
// evaluating the args themselves (by calling them if they are
// functions).  Otherwise, simply return `value` (and assert that
// there are no args).
Spacebars.call = function (value/*, args*/) {
  if (typeof value === 'function') {
    // evaluate arguments if they are functions (by calling them)
    var newArgs = [];
    for (var i = 1; i < arguments.length; i++) {
      var arg = arguments[i];
      newArgs[i-1] = (typeof arg === 'function' ? arg() : arg);
    }

    return value.apply(null, newArgs);
  } else {
    if (arguments.length > 1)
      throw new Error("Can't call non-function: " + value);

    return value;
  }
};

var codeGenMustache = function (tag, mustacheType) {
  var nameCode = codeGenPath(tag.path);
  var argCode = codeGenArgs(tag.args);
  var mustache = (mustacheType || 'mustache');

  return 'Spacebars.' + mustache + '(' + nameCode +
    (argCode ? ', ' + argCode.join(', ') : '') + ')';
};

Spacebars.compile = function (input, options) {
  var tree = Spacebars.parse(input);
  return Spacebars.codeGen(tree, options);
};

Spacebars.codeGen = function (parseTree, options) {
  var tree = parseTree;

  if (isTemplate)
    // optimizing fragments would require being smarter about whether we are
    // in a TEXTAREA, say.
    tree = optimize(tree);

  tree = replaceSpecials(tree);

  // is this a template, rather than a block passed to
  // a block helper, say
  var isTemplate = (options && options.isTemplate);

  var code = '(function () { var self = this; ';
  if (isTemplate) {
    // support `{{> content}}` and `{{> elseContent}}` with
    // lexical scope by creating a local variable in the
    // template's render function.
    code += 'var __content = self.__content, ' +
      '__elseContent = self.__elseContent; ';
  }
  code += 'return ';
  code += HTML.toJS(tree);
  code += '; })';

  code = beautify(code);

  return code;
};

var beautify = function (code) {
  if (Package.minifiers) {
    var result = UglifyJSMinify(code,
                                { fromString: true,
                                  mangle: false,
                                  compress: false,
                                  output: { beautify: true,
                                            indent_level: 2,
                                            width: 80 } });
    var output = result.code;
    // Uglify interprets our expression as a statement and may add a semicolon.
    // Strip trailing semicolon.
    output = output.replace(/;$/, '');
    return output;
  } else {
    // don't actually beautify; no UglifyJS
    return code;
  }
};

// expose for compiler output tests
Spacebars._beautify = beautify;

// `path` is an array of at least one string.
//
// If `path.length > 1`, the generated code may be reactive
// (i.e. it may invalidate the current computation).
//
// No code is generated to call the result if it's a function.
var codeGenPath = function (path) {
  var code = 'self.lookup(' + toJSLiteral(path[0]) + ')';

  if (path.length > 1) {
    code = 'Spacebars.dot(' + code + ', ' +
      _.map(path.slice(1), toJSLiteral).join(', ') + ')';
  }

  return code;
};

// returns: array of source strings, or null if no
// args at all.
var codeGenArgs = function (tagArgs) {
  var kwArgs = null; // source -> source
  var args = null; // [source]

  _.each(tagArgs, function (arg) {
    var argType = arg[0];
    var argValue = arg[1];

    var argCode;
    switch (argType) {
    case 'STRING':
    case 'NUMBER':
    case 'BOOLEAN':
    case 'NULL':
      argCode = toJSLiteral(argValue);
      break;
    case 'PATH':
      argCode = codeGenPath(argValue);
      break;
    default:
      // can't get here
      throw new Error("Unexpected arg type: " + argType);
    }

    if (arg.length > 2) {
      // keyword argument (represented as [type, value, name])
      kwArgs = (kwArgs || {});
      kwArgs[arg[2]] = argCode;
    } else {
      // positional argument
      args = (args || []);
      args.push(argCode);
    }
  });

  // put kwArgs in options dictionary at end of args
  if (kwArgs) {
    args = (args || []);
    args.push('Spacebars.kw(' + makeObjectLiteral(kwArgs) + ')');
  }

  return args;
};

// Call this as `Spacebars.kw({ ... })`.  The return value
// is `instanceof Spacebars.kw`.
Spacebars.kw = function (hash) {
  if (! (this instanceof Spacebars.kw))
    return new Spacebars.kw(hash);

  this.hash = hash || {};
};