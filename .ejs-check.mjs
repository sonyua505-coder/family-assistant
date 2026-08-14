import ejs from 'ejs';
const t = ejs.compile('<p><%= name %></p><%- raw %><input value="<%= attr %>">');
const out = t({ name: '<script>alert(1)</script>', attr: '" onfocus="x', raw: '<b>raw</b>' });
console.log(out);
console.log('escape:', ejs.escape('"><script>'));
