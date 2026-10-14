/* Search rules shared by the browser UI and the Node test suite. Change matching here. */
(function(root){
  const text=value=>String(value||'').toLowerCase();
  function terms(query){return text(query).split(/[\s,，]+/).filter(Boolean)}
  function isCharacterGroup(group){
    if(group&&group.library)return group.library==='character';
    const id=text(group&&group.id),name=String(group&&group.name_cn||'');
    return !!(group&&group.character_library)||id.includes('character')||name.includes('角色');
  }
  function matches(tag, queryTerms, options={}){
    const fields=[tag.name,tag.tag_cn];
    if(options.matchLongDescription)fields.push(tag.tag_cn_long);
    if(options.characterLibrary)fields.push(tag.prompt);
    const values=fields.map(text);
    return queryTerms.every(term=>values.some(field=>field.includes(term)||field.replace(/[_-]/g,' ').includes(term.replace(/[_-]/g,' '))));
  }
  function inArchivedGroup(tag,groups){
    return groups.some(group=>group.search_enabled===false&&(tag.groups||[]).includes(group.id));
  }
  function isCharacterTag(tag,groups){
    return (tag.groups||[]).some(id=>isCharacterGroup(groups.find(group=>group.id===id)));
  }
  function visible(tag,groups,options={}){
    if(options.excludeCharacters&&isCharacterTag(tag,groups))return false;
    if(options.characterLibrary&&options.currentGroup==='character_all')return true;
    const current=groups.find(group=>group.id===options.currentGroup);
    if(current&&current.search_enabled===false)return true;
    return !inArchivedGroup(tag,groups);
  }
  function matchesModel(model,query){
    const q=text(query).trim();
    const sets=Array.isArray(model.prompt_sets)?model.prompt_sets:[];
    return !q||[model.name,model.category,model.prompt,model.recommended_params,model.file_path,model.url,...sets.flatMap(set=>[set.name,set.prompt])].some(value=>text(value).includes(q));
  }
  const confidenceLevels=['MANUAL','A','B','C','D'];
  function confidenceRank(value,unrated='D'){
    const rank=confidenceLevels.indexOf(value||unrated);
    return rank>=0?rank:4;
  }
  function matchesConfidence(value,minimum,unrated='D'){
    if(minimum==='all')return true;
    if(minimum==='none')return !value;
    return confidenceLevels.includes(minimum)&&confidenceRank(value,unrated)<=confidenceRank(minimum,unrated);
  }
  const engine={terms,matches,visible,inArchivedGroup,isCharacterGroup,isCharacterTag,matchesModel,confidenceRank,matchesConfidence};
  if(typeof module!=='undefined'&&module.exports)module.exports=engine;
  else root.DanbooruSearch=engine;
})(typeof window!=='undefined'?window:globalThis);
