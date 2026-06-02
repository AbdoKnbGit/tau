# Rapport comparatif: OpenClaw, Tau et le niveau Bash

## 1. Objectif et lecture generale

Ce rapport compare deux approches:

- **OpenClaw**: une architecture d'agent local-first avec Gateway, politiques d'outils, sandbox, approvals, plugins et un outil `exec` tres encadre.
- **Tau**: un agent de code interactif centre sur les commandes slash, l'execution Bash/PowerShell, l'analyse syntaxique Bash, les permissions et l'experience terminal.

Le mot "unfailable" est interprete ici comme **robuste**, **fail-closed** et **difficile a contourner**, pas comme "impossible a faire echouer". Aucune commande shell n'est vraiment infaillible: elle depend toujours du systeme, du shell disponible, des droits, du chemin courant, des fichiers, du reseau et de l'environnement.

La difference principale est la suivante:

- OpenClaw cherche surtout a rendre l'execution fiable par **architecture et politique d'execution**: quel outil existe, ou il tourne, qui peut l'appeler, s'il faut une approbation, et si l'execution doit passer par sandbox, Gateway ou node.
- Tau cherche surtout a rendre l'execution fiable par **comprehension de la syntaxe Bash et validation locale**: verifier la syntaxe, analyser la commande, classer les commandes simples/complexes, valider les chemins, appliquer des regles de permissions et eviter d'executer quand l'analyse n'est pas sure.

## 2. Niveaux de syntaxe a distinguer

Il faut separer trois niveaux, sinon la comparaison devient confuse.

### 2.1 Syntaxe CLI externe

La CLI externe est ce que l'utilisateur tape dans son terminal avant d'entrer dans l'agent.

OpenClaw expose une commande `openclaw`:

```bash
openclaw onboard
openclaw gateway status
openclaw message send
openclaw agent --message "..."
```

OpenClaw utilise `commander` pour organiser une syntaxe de type:

```bash
openclaw <commande> <sous-commande> [options]
```

Les commandes sont enregistrees par modules: `gateway`, `daemon`, `logs`, `models`, `approvals`, `exec-policy`, `nodes`, `channels`, `config`, `plugins`, `skills`, `cron`, `message`, `sessions`, etc.

Tau expose une commande `tau` et aussi l'alias `claudex`:

```bash
tau
tau --dangerously-skip-permissions
claudex
```

Mais la richesse principale de Tau est dans l'interface interactive: commandes slash, mode Bash, outils, permissions, hooks, plugins et workflows.

### 2.2 Syntaxe de commandes agent

OpenClaw a une syntaxe agent orientee outils. L'outil central pour le shell est `exec`, avec des parametres structures:

```json
{
  "command": "git status",
  "workdir": "C:\\Users\\ok\\Desktop\\project",
  "timeout": 120000,
  "background": false,
  "pty": false,
  "host": "auto",
  "security": "allowlist",
  "ask": "on-miss"
}
```

Le modele ne manipule donc pas seulement une ligne Bash brute. Il choisit aussi un contexte d'execution: `sandbox`, `gateway`, `node` ou `auto`.

Tau a plusieurs formes de commandes:

- commandes slash comme `/login`, `/models`, `/github`, `/learned`, `/fallback`, `/team-mode`;
- commandes locales JSX;
- commandes prompt qui injectent un prompt avec arguments;
- mode Bash utilisateur;
- `BashTool` et `PowerShellTool` pour les appels d'outils.

La syntaxe slash suit globalement:

```text
/nom-de-commande arguments
```

Tau parse les commandes slash avec une logique dediee: il separe le nom de commande, les arguments, detecte les commandes inconnues, supporte les commandes plugin et peut executer certaines commandes dans un sous-agent.

### 2.3 Syntaxe shell/Bash

C'est ici que la difference est la plus importante.

OpenClaw traite la commande shell comme une chaine a executer dans un environnement controle par politique. Son enjeu principal est:

- quel host est autorise;
- quel outil est autorise;
- quelle politique `exec` s'applique;
- faut-il demander une approbation;
- quelles variables d'environnement sont interdites;
- faut-il refuser un fallback dangereux.

Tau, lui, investit beaucoup plus dans la comprehension de Bash:

- validation syntaxique via `bash -n` ou `zsh -n`;
- detection d'un shell Bash compatible, notamment Git Bash sur Windows;
- validation preflight du `workdir` et de certains `cd`;
- analyse AST avec une logique fail-closed;
- extraction de chemins;
- regles de permissions exactes, prefixees et wildcard;
- detection de substitutions, heredocs, redirections, expansions et structures complexes.

## 3. OpenClaw: comment la syntaxe et les commandes sont formees

### 3.1 CLI et organisation

OpenClaw part d'un launcher `openclaw.mjs`, puis charge l'entree TypeScript/JavaScript de la CLI. Le programme CLI est construit avec `commander`, ce qui donne une grammaire standard:

```bash
openclaw <subcli> <action> [options]
```

Les sub-CLI sont chargees de maniere modulaire. OpenClaw peut aussi laisser les plugins enregistrer leurs propres commandes CLI, selon la politique de chargement.

Cette architecture donne une CLI extensible:

- le coeur definit les commandes principales;
- les modules ajoutent les sous-commandes;
- les plugins peuvent etendre l'interface;
- les erreurs de parsing gardent les codes de sortie Commander.

### 3.2 Outil `exec`

L'outil `exec` est la surface d'execution shell d'OpenClaw. Ses parametres principaux sont:

- `command`: commande a executer;
- `workdir`: dossier de travail;
- `env`: variables d'environnement additionnelles;
- `yieldMs`: delai avant de rendre un premier resultat;
- `background`: execution en arriere-plan;
- `timeout`: limite de temps;
- `pty`: pseudo-terminal si necessaire;
- `elevated`: tentative d'elevation;
- `host`: `auto`, `sandbox`, `gateway` ou `node`;
- `security`: niveau de securite;
- `ask`: comportement d'approbation;
- `node`: cible node specifique.

Cette forme est plus structuree qu'un simple appel Bash. Elle permet a OpenClaw de raisonner sur l'environnement d'execution avant de lancer la commande.

### 3.3 Politique d'outils

OpenClaw distingue:

- **tool policy**: quels outils existent et sont appelables;
- **sandbox policy**: ou les outils tournent;
- **elevated policy**: quand `exec` peut sortir de la sandbox;
- **approval policy**: quand l'utilisateur doit valider.

Les profils d'outils peuvent inclure des groupes:

- `group:runtime`: `exec`, `process`, `code_execution`;
- `group:fs`: outils de fichiers;
- `group:web`: outils web;
- `group:sessions`: sessions;
- etc.

Point important: la politique d'outil est un arret dur. Si `exec` est refuse, aucune option interne a `exec` ne devrait pouvoir le reactiver.

### 3.4 Sandbox, Gateway et node

OpenClaw separe fortement:

- **sandbox**: execution isolee;
- **gateway**: execution sur la machine hote via Gateway;
- **node**: execution sur une cible node;
- **auto**: resolution automatique selon la configuration.

Si l'agent demande explicitement `host=sandbox` alors qu'aucun runtime sandbox n'est disponible, OpenClaw echoue de maniere fail-closed au lieu de basculer silencieusement vers l'hote.

C'est une bonne propriete de securite: un agent qui croit etre isole ne doit pas etre execute sur l'hote par surprise.

### 3.5 Approvals et allowlist

OpenClaw a une couche d'approbation pour `exec`, notamment quand une commande sandboxee veut agir sur le host Gateway ou un node.

La politique peut ressembler a:

- `deny`: refuser;
- `allowlist`: autoriser seulement ce qui correspond;
- `ask`: demander;
- `auto`: essayer de classifier/auto-review;
- `full`: autoriser largement.

OpenClaw a aussi des notions comme:

- `safeBins`;
- `strictInlineEval`;
- approval sur heredoc;
- audit de securite;
- fallback d'approbation.

### 3.6 Variables d'environnement

OpenClaw refuse ou nettoie certaines variables d'environnement dangereuses pour l'execution host.

Exemples de risques:

- modification de `PATH`;
- variables de loader;
- variables qui changent la resolution des binaires;
- injection d'environnement.

Cette protection est importante parce qu'une commande apparemment innocente peut devenir dangereuse si `PATH` pointe vers un faux binaire.

### 3.7 Ce qui rend OpenClaw "robuste"

OpenClaw est robuste parce qu'il empile des controles:

1. Le programme CLI structure les commandes.
2. Les outils sont autorises ou refuses par nom.
3. Le host d'execution est explicite.
4. La sandbox peut isoler les effets.
5. `host=sandbox` echoue si la sandbox n'existe pas.
6. Les approvals protegent les appels host/node.
7. Les variables d'environnement host sont filtrees.
8. L'execution en arriere-plan est suivie par des outils de process.
9. Le mode "YOLO/full" est explicite, donc identifiable comme moins sur.

La limite: OpenClaw ne semble pas faire une validation grammaticale Bash aussi poussee que Tau avant chaque commande. Il controle surtout la politique d'execution et les approvals.

## 4. Tau: comment la syntaxe et les commandes sont formees

### 4.1 CLI externe

Tau expose:

```bash
tau
claudex
tau --dangerously-skip-permissions
```

La CLI lance surtout une experience interactive d'agent de code. L'essentiel de la syntaxe utilisateur se trouve ensuite dans:

- commandes slash;
- mode Bash;
- messages utilisateur;
- outils de l'agent;
- plugins et commandes prompt.

### 4.2 Commandes slash

Tau a une registry de commandes. Une commande peut etre:

- **PromptCommand**: transforme `/commande args` en prompt enrichi;
- **LocalCommand**: execute une action locale;
- **LocalJSXCommand**: affiche une interface JSX locale;
- commande plugin chargee depuis des fichiers.

Exemples:

```text
/login
/models
/github
/learned
/fallback
/dangerously-skip-permissions
/team-mode
```

La syntaxe est volontairement simple:

```text
/commande arguments
```

Ce modele est different d'OpenClaw. Tau ne construit pas une grande arborescence `tau <subcli> <action>` pour l'usage principal; il privilegie l'interaction dans la session.

### 4.3 Commandes plugin

Tau peut charger des commandes plugin avec du frontmatter:

- `description`;
- `allowed-tools`;
- `argument-hint`;
- `arguments`;
- `when_to_use`;
- `version`;
- `model`;
- `effort`;
- `disable-model-invocation`;
- `user-invocable`;
- `shell`.

Cela permet de transformer des fichiers de commande en commandes utilisables par l'agent, avec arguments et restrictions d'outils.

### 4.4 Mode Bash utilisateur

Quand l'utilisateur entre une commande en mode Bash, Tau la route vers `processBashCommand`.

Point critique: les commandes Bash initiees directement par l'utilisateur peuvent etre executees avec `dangerouslyDisableSandbox: true`. Cela donne une experience terminal directe, mais c'est une difference forte avec une logique sandbox-first.

Ce choix peut etre correct pour une commande locale explicite de l'utilisateur. Il est plus risque si la commande vient d'un canal distant, d'un plugin non fiable ou d'une automatisation.

### 4.5 `BashTool`

Le `BashTool` de Tau accepte principalement:

- `command`;
- `timeout`;
- `description`;
- `run_in_background`;
- `dangerouslyDisableSandbox`;
- `workdir`;
- un champ interne pour certaines simulations d'edition.

Il renvoie:

- `stdout`;
- `stderr`;
- etat interrompu ou non;
- id de tache background;
- output persiste si necessaire.

Tau a aussi une logique pour:

- commandes de recherche;
- commandes de lecture;
- commandes neutres;
- commandes silencieuses;
- detection de `sleep` bloqueurs;
- execution background;
- persistance de gros outputs.

## 5. Tau au niveau Bash: la difference la plus importante

### 5.1 Detection du shell

Tau cherche un shell Bash/Zsh compatible. Sur Windows, pour des commandes Bash, il prefere Git Bash et ne transforme pas automatiquement toute syntaxe Bash en PowerShell.

C'est important car Bash et PowerShell n'ont pas la meme grammaire:

```bash
ls -la | grep test
```

n'est pas equivalent a:

```powershell
Get-ChildItem | Select-String test
```

Tau evite donc de pretendre qu'une commande Bash peut toujours tourner dans PowerShell.

### 5.2 Validation syntaxique

Tau a une validation syntaxique Bash dediee. Il peut lancer un check du type:

```bash
bash -n -c "commande"
```

ou utiliser `zsh -n` selon le shell trouve.

Si la syntaxe est invalide, Tau peut refuser avant execution et fournir une indication de correction. C'est une propriete de robustesse tres concrete: une commande invalide n'est pas lancee.

### 5.3 Preflight validation

Tau verifie aussi certains problemes avant d'executer:

- `workdir` inexistant;
- `cd dossier && ...` vers un dossier inexistant;
- chemins Windows/POSIX;
- coherence entre dossier courant et commande.

Cette couche evite des erreurs triviales qui produiraient sinon des echecs en cascade.

### 5.4 Analyse AST fail-closed

Tau contient une analyse Bash par AST. Le principe est:

> si la commande n'est pas comprise de facon sure, ne pas l'interpreter comme sure.

Les constructions complexes comme substitutions, heredocs, expansions, subshells, process substitutions ou controle de flux peuvent etre classees comme trop complexes. Dans ce cas, Tau revient vers une demande de permission normale au lieu d'autoriser automatiquement.

C'est une difference majeure avec une simple analyse par regex.

### 5.5 Permissions de commandes

Tau gere des permissions avec plusieurs formes:

- correspondance exacte;
- prefixe;
- wildcard;
- suggestions de permissions;
- blocage des shells nus comme suggestions trop larges;
- limites sur le nombre de sous-commandes analysees.

Tau peut donc dire: cette commande precise est permise, mais une variante plus large ne l'est pas.

### 5.6 Validation des chemins

Tau extrait les chemins de commandes comme:

- `cd`;
- `ls`;
- `find`;
- `rm`;
- `mv`;
- `cp`;
- `cat`;
- `grep`;
- `sed`;
- `git`;
- `jq`.

Il peut appliquer des contraintes de dossiers autorises et detecter des operations dangereuses, par exemple une suppression large.

### 5.7 Protection contre l'injection et les cas difficiles

Tau contient des protections contre:

- substitution de commande;
- process substitution;
- equal expansion zsh;
- caracteres de controle;
- espaces Unicode ambigus;
- heredocs mal parses par certains parseurs;
- redirections;
- commandes trop complexes.

Cette approche est plus proche d'un firewall syntaxique Bash.

## 6. Comparaison directe OpenClaw vs Tau

| Sujet | OpenClaw | Tau |
|---|---|---|
| CLI externe | `openclaw <commande> <sous-commande>` | `tau`, puis interface interactive |
| Systeme de commandes | Commander + sub-CLI + plugins | Registry slash commands + plugins + Local/Prompt/JSX |
| Execution shell | Outil `exec` structure | `BashTool`, `PowerShellTool`, mode Bash |
| Axe principal de securite | Politique, host, sandbox, approvals | Syntaxe Bash, AST, permissions, chemins |
| Choix du host | `auto`, `sandbox`, `gateway`, `node` | Shell local/sandbox selon config et outil |
| Fail-closed fort | `host=sandbox` echoue si sandbox absente | AST/syntaxe echoue si non compris ou invalide |
| Approvals | Couche explicite pour host/node/gateway | Permissions outil/commande, prompts |
| Env host | Filtrage strict de variables dangereuses | Gestion shell/env dans provider et sandbox |
| Windows | Recommandations pour executables directs, pas de wrappers inutiles | Bash via Git Bash; PowerShell si shell configure |
| Complexite Bash | Moins centree sur grammaire Bash | Tres centree sur parse/validation Bash |
| Background | `background`, `yieldMs`, outil `process` | `run_in_background`, LocalShellTask, output persiste |
| Risque principal | Mode full/YOLO et politique trop ouverte | `dangerouslyDisableSandbox` et commandes utilisateur non sandboxees |

## 7. Difference au niveau Bash

### 7.1 OpenClaw: Bash comme payload d'une politique d'execution

Dans OpenClaw, la ligne shell est principalement un payload envoye a un runtime controle. La question est:

```text
Cette commande a-t-elle le droit d'etre executee sur ce host avec cette politique?
```

Donc OpenClaw repond surtout a:

- qui demande;
- quel outil;
- quel host;
- quelle sandbox;
- quelle approval;
- quelle allowlist;
- quelle variable d'environnement;
- quel niveau de securite.

### 7.2 Tau: Bash comme langage a analyser

Dans Tau, la ligne Bash est un langage a parser. La question est:

```text
Cette commande Bash est-elle syntaxiquement valide, comprehensible et compatible avec les permissions?
```

Donc Tau repond surtout a:

- le shell existe-t-il;
- la syntaxe est-elle valide;
- l'AST est-il simple ou trop complexe;
- quels chemins sont touches;
- quelle regle de permission matche;
- la commande contient-elle des substitutions ou expansions dangereuses;
- le workdir existe-t-il.

### 7.3 Consequence pratique

OpenClaw est meilleur quand le probleme principal est:

- plusieurs agents;
- plusieurs hosts;
- execution distante;
- Gateway;
- sandbox;
- approvals;
- politique d'organisation;
- separation entre outils autorises et interdits.

Tau est meilleur quand le probleme principal est:

- execution Bash locale;
- UX terminal;
- prevention des erreurs de syntaxe;
- classification fine d'une ligne Bash;
- permissions par commande;
- validation des chemins;
- experience interactive de developpeur.

## 8. Points faibles et risques

### 8.1 Risques OpenClaw

1. **Mode full/YOLO**: si la politique est trop ouverte, les garde-fous deviennent volontairement faibles.
2. **Tool policy par nom**: refuser `write` ne rend pas `exec` read-only, car `exec` peut modifier des fichiers.
3. **Analyse Bash moins profonde**: OpenClaw est moins oriente grammaire Bash qu'un systeme comme Tau.
4. **Sandbox optionnelle**: si elle n'est pas activee, beaucoup repose sur approvals et politique.
5. **Reference stale a Tau**: le repo OpenClaw contient une reference a `src/process/tau-rpc.ts` dans la configuration de tests, mais le fichier n'existe pas.

### 8.2 Risques Tau

1. **`dangerouslyDisableSandbox`**: les commandes Bash initiees par l'utilisateur peuvent sortir de la sandbox.
2. **Bash sur Windows**: dependance a Git Bash pour la vraie syntaxe Bash.
3. **Complexite des parseurs**: Bash est difficile a parser parfaitement; Tau mitige par fail-closed, mais le risque de cas limite reste reel.
4. **Permissions trop larges**: une regle prefixee ou wildcard mal choisie peut autoriser plus que prevu.
5. **Canaux distants**: si une commande non locale arrive dans le meme chemin qu'une commande utilisateur explicite, il faut une separation stricte.

## 9. Comment ameliorer Tau en s'inspirant d'OpenClaw

### 9.1 Ajouter une notion de cible explicite

Tau pourrait formaliser une option proche de:

```json
{
  "target": "local | sandbox | remote | node",
  "command": "...",
  "workdir": "..."
}
```

Aujourd'hui, Tau a deja sandbox, shell providers et permissions, mais une abstraction explicite du host rendrait les decisions plus lisibles.

### 9.2 Rendre la sandbox plus visible

Tau devrait afficher clairement, pour chaque commande sensible:

- sandbox active ou non;
- dossier autorise;
- shell utilise;
- permission qui a autorise ou bloque;
- raison du refus.

Une commande `/bash-doctor` ou `/shell-doctor` serait utile.

### 9.3 Separer commandes locales explicites et commandes venant d'un canal

Les commandes tapees directement par l'utilisateur peuvent avoir plus de privileges que les commandes venues de:

- plugin;
- WhatsApp;
- GitHub;
- automatisation;
- sous-agent;
- prompt importe.

Tau devrait appliquer une politique differente selon la source.

### 9.4 Ajouter une policy globale lisible

OpenClaw a une notion claire de profils et groupes d'outils. Tau pourrait ajouter un fichier de politique plus declaratif:

```yaml
tools:
  allow:
    - BashTool
    - Read
    - Grep
  deny:
    - Write
shell:
  defaultTarget: sandbox
  requireApprovalForHost: true
  denyPathMutation: true
```

L'important est que `deny` gagne toujours sur `allow`.

### 9.5 Ajouter un mode dry-run/decision trace

Avant execution:

```text
Commande: rm -rf build
Shell: Git Bash
Workdir: C:\Users\ok\Desktop\claudex
Syntaxe: valide
AST: simple
Chemins touches: build
Permission: ask
Sandbox: active
Decision: demander confirmation
```

Cela aiderait a comprendre pourquoi une commande est autorisee ou bloquee.

### 9.6 Mieux unifier Bash et PowerShell

Tau devrait documenter tres clairement:

- mode Bash: syntaxe Bash, Git Bash requis sur Windows;
- mode PowerShell: syntaxe PowerShell;
- pas de conversion magique Bash vers PowerShell;
- erreurs typiques et corrections.

### 9.7 Renforcer les tests differentiels

Ajouter des tests sur:

- heredocs;
- command substitution;
- nested quotes;
- redirections;
- process substitution;
- chemins Windows avec espaces;
- `cd` + commande;
- wildcard permissions;
- commandes tres longues;
- Unicode whitespace;
- `rm`, `mv`, `cp`, `sed`, `find`, `git`.

## 10. Comment ameliorer OpenClaw en s'inspirant de Tau

### 10.1 Ajouter une validation Bash optionnelle

OpenClaw pourrait ajouter un mode:

```yaml
tools:
  exec:
    bashSyntaxPreflight: true
    astSecurityPreflight: true
```

Cela donnerait une couche supplementaire avant allowlist/approval.

### 10.2 Ajouter une trace de decision plus pedagogique

Pour chaque refus `exec`, OpenClaw pourrait afficher:

- outil demande;
- host resolu;
- politique active;
- allowlist touchee;
- approval requise;
- variable d'environnement refusee;
- sandbox active ou absente.

### 10.3 Nettoyer la reference `tau-rpc.ts`

La configuration de test reference `src/process/tau-rpc.ts`, mais ce fichier n'est pas present. Il faudrait:

- supprimer cette reference si elle est obsolete;
- ou restaurer le fichier si la fonctionnalite doit exister.

### 10.4 Activer sandbox par defaut pour plus de profils

Pour les agents non principaux ou les canaux distants, OpenClaw pourrait preferer:

```yaml
agents:
  defaults:
    sandbox: on
```

ou au minimum rendre l'absence de sandbox tres visible.

### 10.5 Ajouter une classification de commande plus fine

OpenClaw a deja approvals et allowlist. Une classification syntaxique plus proche de Tau pourrait reduire les approvals inutiles tout en gardant la securite:

- simple read-only;
- simple write;
- package manager;
- network;
- destructive;
- unknown/complex.

## 11. Plan de priorite recommande

### P0: securite immediate

1. Dans Tau, verifier que les commandes venant de canaux distants ne peuvent pas passer par le chemin `dangerouslyDisableSandbox` reserve a l'utilisateur local.
2. Dans OpenClaw, corriger ou supprimer la reference stale `src/process/tau-rpc.ts`.
3. Dans les deux projets, documenter clairement que `exec`/`BashTool` peut modifier le systeme meme si les outils de fichiers directs sont refuses.

### P1: meilleure observabilite

1. Ajouter une commande de diagnostic Bash dans Tau.
2. Ajouter une trace de decision `exec` dans OpenClaw.
3. Montrer le shell reel, le workdir, le host et la sandbox avant les commandes sensibles.

### P2: convergence technique

1. Reutiliser une analyse AST Bash dans OpenClaw pour les profils stricts.
2. Ajouter dans Tau une politique declarative plus proche des profils OpenClaw.
3. Harmoniser les noms de parametres: `host`, `target`, `ask`, `security`, `pty`, `background`, `timeout`.

## 12. Conclusion

OpenClaw et Tau ne resolvent pas exactement le meme probleme.

OpenClaw est plus fort sur l'architecture d'execution: Gateway, sandbox, node, approvals, profils d'outils et separation claire entre politique et execution. Son modele est adapte aux agents multi-canaux, aux environnements distribues et aux controles administrables.

Tau est plus fort sur la comprehension locale de Bash: validation syntaxique, preflight, AST fail-closed, permissions par commande, validation de chemins et UX interactive. Son modele est adapte au developpement quotidien, ou l'agent doit comprendre finement les commandes terminal.

La meilleure amelioration serait de combiner les deux philosophies:

- OpenClaw gagnerait a adopter plus de validation syntaxique Bash avant execution.
- Tau gagnerait a adopter une separation de host/politique plus explicite, surtout pour sandbox, canaux distants et approvals.

En resume:

```text
OpenClaw = securite par architecture d'execution.
Tau      = securite par analyse de la commande Bash.
Ideal    = architecture explicite + analyse Bash fail-closed.
```

## 13. Pourquoi OpenClaw peut reussir du premier coup quand Tau fait plusieurs essais

Le cas que tu donnes est le plus important: demander quelque chose comme "inserer/ajouter des nodes dans Docker" ou manipuler des nodes, puis voir Tau essayer plusieurs syntaxes avant de tomber sur la bonne, alors qu'OpenClaw utilise souvent la bonne forme des le premier appel.

La raison n'est pas que Tau ne sait pas parser Bash. La raison est qu'il y a **deux syntaxes differentes**:

1. **Syntaxe du shell**: est-ce que la ligne est du Bash valide?
2. **Syntaxe metier de l'outil**: est-ce que `docker`, `openclaw nodes`, `kubectl`, `gh`, etc. acceptent vraiment ces flags, cet ordre d'arguments et ce JSON?

Tau verifie bien le premier niveau. Par exemple, il peut detecter:

```bash
docker run --name test image
```

comme Bash valide.

Mais cette validation ne prouve pas que la commande Docker est correcte dans le contexte demande. Pour Bash, tout ceci est syntaxiquement valide:

```bash
docker insert nodes foo
docker node insert foo
docker compose node add foo
```

Bash ne sait pas si `insert`, `node`, `nodes` ou `compose node add` sont de vraies sous-commandes Docker. Il ne fait que lancer `docker` avec des arguments.

### 13.1 Ce qu'OpenClaw sait mieux dans ce cas

OpenClaw a des surfaces explicites pour les nodes. Par exemple, la CLI declare:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command <command> --params <json>
```

Et le code impose:

- `--node` obligatoire;
- `--command` obligatoire;
- `--params` comme JSON;
- parsing JSON avant appel RPC;
- refus de certaines commandes reservees au shell;
- resolution du node par id, nom ou IP.

Donc le modele n'a pas besoin d'inventer une commande Docker ou Bash. Il peut appeler une API/tool avec schema:

```json
{
  "action": "invoke",
  "node": "Android Node",
  "invokeCommand": "canvas.navigate",
  "invokeParamsJson": "{\"url\":\"http://...\"}"
}
```

Cette forme est plus difficile a rater parce que le schema dit quoi fournir.

Pour Docker sandbox aussi, OpenClaw documente des chemins de configuration precis:

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "backend": "docker",
        "docker": {
          "setupCommand": "apt-get update && apt-get install -y git curl"
        }
      }
    }
  }
}
```

Le modele a donc des noms de champs stables: `agents.defaults.sandbox`, `backend`, `docker`, `setupCommand`, `binds`, `network`, etc.

### 13.2 Ce que Tau sait verifier

Tau sait verifier beaucoup de choses autour du shell:

- Bash disponible ou non;
- Git Bash requis sur Windows;
- PowerShell utilise par erreur dans Bash;
- erreurs de quoting;
- substitutions dangereuses;
- workdir inexistant;
- commande repetee qui echoue;
- erreurs de permissions;
- chemins dangereux.

Mais une commande Docker fausse peut etre du Bash parfaitement valide.

Exemple:

```bash
docker compose add-node worker1
```

Pour Bash: valide.

Pour Docker: probablement invalide, car Docker Compose n'a pas forcement une sous-commande `add-node`.

Tau ne peut le savoir avant execution que si:

- il consulte `docker compose --help`;
- il lit la documentation;
- il lit le code/projet local;
- il dispose deja d'une commande specialisee avec schema;
- le prompt contient des exemples exacts.

### 13.3 Pourquoi Tau fait parfois 3 tries

Le cycle typique est:

1. Le modele propose une commande plausible selon sa memoire.
2. Bash accepte la syntaxe, donc la commande est executee.
3. Docker repond `unknown command`, `unknown flag`, `invalid option` ou `usage`.
4. Tau ajoute du contexte d'erreur.
5. Tau peut aller chercher `docker <subcommand> --help`.
6. Le modele corrige.

Tau a meme un garde-fou pour bloquer les boucles de retry. Le code indique que certains modeles peuvent repeter des commandes echouees, donc Tau suit les echecs et bloque les variantes trop similaires pour forcer un diagnostic.

Donc le probleme n'est pas seulement "syntaxe Bash". C'est surtout:

```text
syntaxe Bash valide != syntaxe Docker/OpenClaw/Kubernetes valide
```

### 13.4 Pourquoi OpenClaw evite mieux ce piege

OpenClaw evite ce piege quand il expose une action comme outil structure.

Au lieu de demander au modele:

```text
Devine la bonne commande shell.
```

OpenClaw lui donne:

```text
Utilise l'action nodes.invoke avec ces champs obligatoires.
```

Cela reduit l'espace d'erreur. Le modele ne choisit plus entre 20 syntaxes possibles; il remplit un formulaire.

La difference devient:

```text
Tau raw shell:
  modele -> devine commande -> Bash valide -> outil externe peut refuser

OpenClaw tool/schema:
  modele -> remplit schema -> validation locale -> RPC/API stable
```

### 13.5 Comment ameliorer Tau pour reussir plus souvent du premier coup

Pour que Tau se comporte davantage comme OpenClaw, il faut reduire les cas ou il doit deviner une CLI externe.

Ameliorations recommandees:

1. **Verifier avant d'essayer**
   Pour toute CLI inconnue ou sous-commande incertaine, executer d'abord:

   ```bash
   docker --help
   docker compose --help
   docker node --help
   ```

   ou lire les docs/source locale au lieu de tenter directement.

2. **Ajouter des tools structures pour les domaines frequents**
   Par exemple un outil interne Tau:

   ```json
   {
     "tool": "DockerTool",
     "action": "compose_up",
     "file": "docker-compose.yml",
     "detach": true
   }
   ```

   Ce serait beaucoup plus fiable qu'une commande Bash inventee.

3. **Ajouter un mode "syntax discovery first"**
   Si la demande contient une CLI externe comme `docker`, `kubectl`, `gh`, `npm`, `pnpm`, `openclaw`, Tau devrait d'abord detecter la version et l'aide:

   ```bash
   docker version
   docker compose version
   docker compose --help
   ```

4. **Mettre les exemples exacts dans le prompt court**
   Les petits modeles imitent mieux des exemples concrets qu'une longue regle abstraite. Tau a deja commence a faire cela dans ses descriptions shell compactes.

5. **Transformer les erreurs "unknown command/flag" en diagnostic obligatoire**
   Apres un echec de type `unknown flag`, ne pas autoriser une deuxieme supposition directe. Forcer:

   ```bash
   <commande> --help
   ```

   puis seulement retry.

6. **Ajouter une memoire de syntaxe locale**
   Si Tau apprend que, dans ce repo, la bonne forme est:

   ```bash
   docker compose run --rm openclaw-cli ...
   ```

   il devrait la reutiliser au lieu de revenir a une forme generique.

### 13.6 Regle simple

Pour ameliorer la fiabilite:

```text
Si la commande est une API connue par le projet: utiliser un tool/schema.
Si la commande est une CLI externe inconnue: lire --help avant d'agir.
Si la commande est juste du shell simple: validation Bash suffit.
```

Dans ton exemple, OpenClaw reussit mieux car "nodes" est une surface native avec schema et validation. Tau echoue plus souvent quand il traite la demande comme une commande shell brute et doit deviner la grammaire de Docker ou d'une autre CLI.

## 14. Comment generaliser aux commandes tres complexes

Une petite commande ne peut pas etre "generale" toute seule. Ce qui peut etre general, c'est la **methode de construction**.

Pour une commande tres compliquee, l'agent ne devrait pas deviner une longue ligne complete. Il devrait construire la commande en couches:

```text
intention utilisateur
-> domaine/outillage concerne
-> grammaire exacte de l'outil local
-> parametres necessaires
-> commande candidate
-> validation/dry-run si possible
-> execution
```

### 14.1 Exemple: recuperer un tree dans un repo pour un fichier precis

La demande peut vouloir dire plusieurs choses:

- afficher l'arborescence du repo autour d'un fichier;
- afficher les fichiers suivis par Git sous un dossier;
- afficher l'arbre Git d'un commit;
- afficher l'historique d'un fichier;
- afficher les dependances d'un fichier;
- afficher les symboles/classes/fonctions d'un fichier.

Donc la bonne commande depend du sens exact.

Mauvaise strategie:

```bash
tree repo file
```

ou inventer une commande longue.

Bonne strategie:

1. Identifier le repo et le fichier.
2. Verifier que le fichier existe.
3. Verifier si on veut le filesystem, Git, ou l'AST du code.
4. Choisir l'outil adapte.

Exemples possibles:

```bash
git ls-tree -r --name-only HEAD -- path/to/dir
```

pour l'arbre Git suivi par le commit courant.

```bash
rg --files path/to/dir
```

pour l'arbre de fichiers reel dans le workspace.

```bash
git log --oneline -- path/to/file
```

pour l'historique du fichier.

Ici la generalisation ne vient pas d'une seule commande. Elle vient de la decision:

```text
si l'utilisateur demande l'etat Git -> git ls-tree/log
si l'utilisateur demande les fichiers reels -> rg --files/tree
si l'utilisateur demande la structure code -> AST/LSP
```

### 14.2 Exemple: lancer un test avec beaucoup de parametres

Les tests sont un bon exemple car chaque projet a sa grammaire:

- `npm test`;
- `pnpm test`;
- `pnpm vitest run`;
- `npx jest path --runInBand`;
- `pytest tests/foo.py -k "name"`;
- `go test ./pkg/... -run TestName`;
- `cargo test test_name -- --nocapture`;
- `dotnet test --filter ...`;
- `mvn test -Dtest=...`;
- `gradle test --tests ...`.

La bonne syntaxe depend:

- du gestionnaire de package;
- du framework;
- des scripts `package.json`;
- de la configuration locale;
- du separateur `--`;
- du shell;
- du chemin exact;
- du nom exact du test;
- de la plateforme.

Donc l'agent doit d'abord decouvrir:

```bash
cat package.json
pnpm test -- --help
pnpm exec vitest --help
pytest --help
go test -h
```

Puis construire une commande.

Exemple de construction:

```text
Projet Node + pnpm + Vitest
-> lire package.json
-> trouver script "test"
-> verifier aide Vitest
-> si fichier cible: pnpm test -- path/to/file.test.ts
-> si nom de test: pnpm test -- path/to/file.test.ts -t "nom"
```

Ce n'est pas une regle universelle de shell. C'est une recette de raisonnement.

### 14.3 Les trois formes de generalisation

Il y a trois niveaux possibles.

#### A. Generalisation par grammaire shell

Tau sait valider:

- quoting;
- pipes;
- redirections;
- variables;
- separateur;
- syntaxe Bash vs PowerShell.

Cela evite les erreurs de shell, mais pas les erreurs de CLI metier.

#### B. Generalisation par introspection locale

L'agent regarde le projet:

- `package.json`;
- `pyproject.toml`;
- `pytest.ini`;
- `go.mod`;
- `Cargo.toml`;
- `Makefile`;
- `justfile`;
- `.github/workflows`;
- docs locales;
- scripts existants;
- sorties `--help`.

C'est ce niveau qui permet de trouver la bonne commande de test ou de build.

#### C. Generalisation par schema/tool

Le niveau le plus fiable est un outil structure:

```json
{
  "tool": "RunTest",
  "framework": "vitest",
  "file": "src/foo.test.ts",
  "testName": "handles docker nodes",
  "updateSnapshots": false
}
```

L'outil traduit ensuite vers la commande exacte:

```bash
pnpm vitest run src/foo.test.ts -t "handles docker nodes"
```

Si le projet change de framework, seul l'adaptateur change. Le modele ne devine plus toute la ligne.

### 14.4 Pourquoi les schemas sont superieurs aux longues commandes

Une commande longue est fragile:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml run --rm --no-deps --entrypoint node openclaw-gateway ...
```

Une erreur dans:

- ordre des flags;
- quoting JSON;
- placement de `--`;
- nom du service;
- entrypoint;
- chemin Windows/POSIX;
- variable d'environnement;

peut casser toute la commande.

Un schema reduit le risque:

```json
{
  "composeFiles": ["docker-compose.yml", "docker-compose.extra.yml"],
  "service": "openclaw-gateway",
  "entrypoint": "node",
  "remove": true,
  "noDeps": true,
  "args": ["dist/index.js", "health"]
}
```

La ligne shell devient une compilation depuis des champs valides.

### 14.5 Regle pratique pour Tau

Pour generaliser correctement, Tau devrait suivre cette regle:

```text
Commande simple connue:
  executer directement apres validation Bash.

Commande shell valide mais outil/metier incertain:
  consulter --help, scripts locaux ou docs avant execution.

Commande longue/repetitive:
  creer une recette locale ou un tool structure.

Commande dangereuse ou destructive:
  dry-run, permission, ou confirmation.
```

### 14.6 Ce qu'il faut ajouter pour etre proche d'OpenClaw

Pour eviter les 3 essais sur les commandes complexes, Tau devrait avoir:

1. **un detecteur de domaine**: Docker, Git, tests, package manager, Kubernetes, OpenClaw, etc.;
2. **un collecteur de grammaire locale**: `--help`, fichiers config, scripts;
3. **un constructeur de commande**: transforme des champs en ligne shell;
4. **un validateur**: Bash syntax + chemin + permissions + dry-run;
5. **une memoire locale**: retenir la commande qui marche dans ce repo;
6. **des tools specialises** pour les domaines frequents.

La generalisation solide ne consiste donc pas a memoriser toutes les commandes possibles. Elle consiste a transformer:

```text
demande vague -> intention structuree -> schema local -> commande valide
```

OpenClaw est plus proche de ce modele quand il fournit deja une API/tool structuree. Tau peut y arriver aussi, mais il doit moins deviner en Bash brut et plus decouvrir/compiler la commande.
