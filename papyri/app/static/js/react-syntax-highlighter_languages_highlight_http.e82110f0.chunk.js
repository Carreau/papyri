(self.webpackChunkpapyri_frontend=self.webpackChunkpapyri_frontend||[]).push([[528],{7053:function(n){function e(){for(var n=arguments.length,e=new Array(n),a=0;a<n;a++)e[a]=arguments[a];return e.map((function(n){return(e=n)?"string"===typeof e?e:e.source:null;var e})).join("")}n.exports=function(n){var a="HTTP/(2|1\\.[01])",s={className:"attribute",begin:e("^",/[A-Za-z][A-Za-z0-9-]*/,"(?=\\:\\s)"),starts:{contains:[{className:"punctuation",begin:/: /,relevance:0,starts:{end:"$",relevance:0}}]}},t=[s,{begin:"\\n\\n",starts:{subLanguage:[],endsWithParent:!0}}];return{name:"HTTP",aliases:["https"],illegal:/\S/,contains:[{begin:"^(?="+a+" \\d{3})",end:/$/,contains:[{className:"meta",begin:a},{className:"number",begin:"\\b\\d{3}\\b"}],starts:{end:/\b\B/,illegal:/\S/,contains:t}},{begin:"(?=^[A-Z]+ (.*?) "+a+"$)",end:/$/,contains:[{className:"string",begin:" ",end:" ",excludeBegin:!0,excludeEnd:!0},{className:"meta",begin:a},{className:"keyword",begin:"[A-Z]+"}],starts:{end:/\b\B/,illegal:/\S/,contains:t}},n.inherit(s,{relevance:0})]}}}}]);
//# sourceMappingURL=react-syntax-highlighter_languages_highlight_http.e82110f0.chunk.js.map