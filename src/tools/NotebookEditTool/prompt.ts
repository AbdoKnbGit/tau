export const DESCRIPTION =
  'Edit cells in a Jupyter notebook after reading the notebook.'
export const PROMPT = `Edit one cell after reading the notebook. Use the absolute path and exact Read cell ID (for example "cell-0", not "0"). Replace/delete require cell_id; insert omits it for the beginning or supplies the cell after which to insert. new_source is always required (empty for delete), and insert requires cell_type. Replace is the default. An already-applied replace is a successful no-op; do not retry it.`
