import React, { createContext, useContext } from "react";

export const isHandlebarsBuild =
  typeof process !== "undefined" && process.env?.IS_HANDLEBARS_BUILD === "true";

const HandlebarsContext = createContext<any>(null);
const InsideEachContext = createContext<{ value: any; index?: number } | null>(
  null,
);

/**
 * Evaluates a string condition against a data object.
 * Supports: "prop", "nested.prop", "array.0.prop", "array[0].prop", "A && B", "A || B", "!A"
 */
function evaluate(condition: string, data: any): boolean {
  if (typeof condition !== "string") return !!condition;
  if (!data) return true; // Default to true if no data provided (e.g. in dev without provider)

  // Handle Logical OR
  if (condition.includes("||")) {
    return condition.split("||").some((p) => evaluate(p.trim(), data));
  }

  // Handle Logical AND
  if (condition.includes("&&")) {
    return condition.split("&&").every((p) => evaluate(p.trim(), data));
  }

  // Handle Negation
  if (condition.startsWith("!")) {
    return !evaluate(condition.substring(1).trim(), data);
  }

  // Handle nested paths and array indices: "order.id", "items.0.name", "items[0].name"
  const parts = condition.split(/\.|\[|\]/).filter(Boolean);
  let val = data;
  for (const part of parts) {
    if (val === null || val === undefined) return false;
    val = val[part];
  }

  // For arrays, treat empty as falsy
  if (Array.isArray(val)) return val.length > 0;

  return !!val;
}

/**
 * Handlebars helper components to make logic explicit in React components.
 * These components render markers that the build script uses to identify blocks.
 */
export const Handlebars = {
  /**
   * Provides data context for Handlebars helpers to work in React previews.
   */
  Provider: ({ data, children }: { data: any; children: React.ReactNode }) => (
    <HandlebarsContext.Provider value={data}>
      {children}
    </HandlebarsContext.Provider>
  ),

  /**
   * Renders a Handlebars {{#if condition}} block.
   */
  If: ({
    condition,
    children,
  }: {
    condition: string;
    children: React.ReactNode;
  }) => {
    const data = useContext(HandlebarsContext);

    if (isHandlebarsBuild) {
      return React.createElement("hb-if", { condition }, children);
    }

    const result = evaluate(condition, data);
    const childrenArray = React.Children.toArray(children);
    const elseIndex = childrenArray.findIndex(
      (child: any) => child.type === Handlebars.Else,
    );

    if (elseIndex !== -1) {
      if (result) {
        return <>{childrenArray.slice(0, elseIndex)}</>;
      } else {
        return <>{childrenArray[elseIndex]}</>;
      }
    }

    if (!result) return null;

    return <>{children}</>;
  },

  /**
   * Renders a Handlebars {{else}} block.
   */
  Else: ({ children }: { children: React.ReactNode }) => {
    if (isHandlebarsBuild) {
      return React.createElement("hb-else", null, children);
    }
    return <>{children}</>;
  },

  /**
   * Renders a Handlebars {{#each array}} block.
   */
  Each: ({
    array,
    itemVar,
    children,
  }: {
    array: string;
    itemVar?: string;
    children: React.ReactNode;
  }) => {
    const data = useContext(HandlebarsContext);
    const inner = (
      <InsideEachContext.Provider value={{ value: data?.[array] }}>
        {children}
      </InsideEachContext.Provider>
    );

    if (isHandlebarsBuild) {
      return React.createElement("hb-each", { array, itemVar }, inner);
    }

    const show = evaluate(array, data);
    if (!show) return null;

    return data?.[array]?.map((item: any, index: number) => {
      return (
        <InsideEachContext.Provider
          value={{ value: data?.[array], index: index }}
        >
          {children}
        </InsideEachContext.Provider>
      );
    });
  },

  /**
   * Renders a Handlebars {{variable}} tag.
   * Inside an Each block uses {{this.name}}, otherwise {{name}}.
   */
  Val: ({ name, value }: { name: string; value?: string | number }) => {
    const insideEach = useContext(InsideEachContext);

    if (isHandlebarsBuild) {
      const ref = insideEach ? `this.${name}` : name;
      return <>{`{{${ref}}}`}</>;
    }

    if (insideEach) {
      return <>{insideEach.value?.[insideEach.index ?? 0]}</>;
    }

    return <>{value}</>;
  },
};

