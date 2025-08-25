// src/modules/database.js
const admin = require('../config/firebase-init');
const db = admin.firestore();

// --- State Management ---
async function getFocusedSession(chatId) {
    const chatStateRef = db.collection('chat_states').doc(String(chatId));
    const chatStateDoc = await chatStateRef.get();
    if (!chatStateDoc.exists || !chatStateDoc.data().focusedSessionId) return null;
    const sessionId = chatStateDoc.data().focusedSessionId;
    const sessionRef = db.collection('sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
        await chatStateRef.delete();
        return null;
    }
    return { id: sessionDoc.id, ref: sessionRef, data: sessionDoc.data() };
}
async function setFocusedSession(chatId, sessionId) {
    await db.collection('chat_states').doc(String(chatId)).set({ focusedSessionId: sessionId });
}
async function clearFocusedSession(chatId) {
    await db.collection('chat_states').doc(String(chatId)).delete();
}

// --- Conversation Context ---
async function setPendingAction(chatId, action) {
    await db.collection('chat_states').doc(String(chatId)).set({ pendingAction: action }, { merge: true });
}
async function getPendingAction(chatId) {
    const doc = await db.collection('chat_states').doc(String(chatId)).get();
    return doc.exists ? doc.data().pendingAction : null;
}
async function clearPendingAction(chatId) {
    const chatStateRef = db.collection('chat_states').doc(String(chatId));
    const doc = await chatStateRef.get();
    if (doc.exists && doc.data().pendingAction) {
        await chatStateRef.update({
            pendingAction: admin.firestore.FieldValue.delete()
        });
    }
}

// --- Session Management ---
async function createSession(chatId, userId, username, sessionName) {
    const newSessionRef = db.collection('sessions').doc();
    const newMemberRef = newSessionRef.collection('members').doc();
    const batch = db.batch();
    batch.set(newSessionRef, { chatId, name: sessionName, status: 'active', createdAt: admin.firestore.FieldValue.serverTimestamp() });
    batch.set(newMemberRef, { userId, username, type: 'telegram' });
    await batch.commit();
    return newSessionRef.id;
}
async function reopenSession(sessionId) {
    await db.collection('sessions').doc(sessionId).update({ status: 'active' });
}
async function endSession(sessionId) {
    await db.collection('sessions').doc(sessionId).update({ status: 'ended', endedAt: admin.firestore.FieldValue.serverTimestamp() });
}
async function getSessionsByChat(chatId) {
    return await db.collection('sessions').where('chatId', '==', chatId).orderBy('createdAt', 'desc').get();
}
async function getSessionById(sessionId) {
    const sessionRef = db.collection('sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) return null;
    return { id: sessionDoc.id, ref: sessionRef, data: sessionDoc.data() };
}

// --- Transaction & Member Management ---
async function findOrCreateMembers(session, members) {
    const memberRefs = {};
    const membersRef = session.ref.collection('members');
    for (const member of members) {
        let memberSnapshot;
        if (member.type === 'telegram') {
            memberSnapshot = await membersRef.where('userId', '==', member.id).limit(1).get();
        } else {
            memberSnapshot = await membersRef.where('username', '==', member.username).where('type', '==', 'custom').limit(1).get();
        }
        if (memberSnapshot.empty) {
            const newMemberRef = membersRef.doc();
            const newMemberData = { username: member.username, type: member.type };
            if (member.type === 'telegram') newMemberData.userId = member.id;
            await newMemberRef.set(newMemberData);
            memberRefs[member.username] = newMemberRef.id;
        } else {
            memberRefs[member.username] = memberSnapshot.docs[0].id;
        }
    }
    return memberRefs;
}
async function addTransaction(session, payer, consumer, amount, description) {
    const membersToEnsure = [payer, consumer];
    const memberIdsMap = await findOrCreateMembers(session, membersToEnsure);
    const payerId = memberIdsMap[payer.username];
    const consumerId = memberIdsMap[consumer.username];
    await session.ref.collection('transactions').add({
        payerId,
        consumerId,
        amount,
        description,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}
async function getTransactions(sessionRef) {
    return await sessionRef.collection('transactions').orderBy('createdAt', 'asc').get();
}
async function deleteTransaction(sessionRef, transactionId) {
    await sessionRef.collection('transactions').doc(transactionId).delete();
}

// --- Calculation ---
async function calculateSettlement(sessionRef) {
    const membersSnapshot = await sessionRef.collection('members').get();
    const transactionsSnapshot = await sessionRef.collection('transactions').get();
    if (membersSnapshot.empty) return { plan: [], summary: null };
    const members = {};
    const memberIdToUsername = {};
    membersSnapshot.forEach(doc => {
        members[doc.id] = { username: doc.data().username, balance: 0 };
        memberIdToUsername[doc.id] = doc.data().username;
    });
    let totalExpenses = 0;
    transactionsSnapshot.forEach(doc => {
        const tx = doc.data();
        totalExpenses += tx.amount;
        if (members[tx.payerId]) {
            members[tx.payerId].balance += tx.amount;
        }
        if (members[tx.consumerId]) {
            members[tx.consumerId].balance -= tx.amount;
        }
    });
    const summary = { totalExpenses, memberCount: membersSnapshot.size, payments: [] };
    const balances = Object.values(members).map(data => {
        let paid = 0;
        transactionsSnapshot.forEach(doc => {
            if (memberIdToUsername[doc.data().payerId] === data.username) {
                paid += doc.data().amount;
            }
        });
        summary.payments.push({ username: data.username, paid });
        return { username: data.username, balance: data.balance };
    });
    const debtors = balances.filter(p => p.balance < 0).sort((a, b) => a.balance - b.balance);
    const creditors = balances.filter(p => p.balance > 0).sort((a, b) => b.balance - a.balance);
    const settlementPlan = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
        const debtor = debtors[i];
        const creditor = creditors[j];
        const amount = Math.min(-debtor.balance, creditor.balance);
        if (amount > 0.5) {
            settlementPlan.push({ from: debtor.username, to: creditor.username, amount: Math.round(amount) });
        }
        debtor.balance += amount;
        creditor.balance -= amount;
        if (Math.abs(debtor.balance) < 1) i++;
        if (Math.abs(creditor.balance) < 1) j++;
    }
    return { plan: settlementPlan, summary };
}

module.exports = {
    getFocusedSession, setFocusedSession, clearFocusedSession,
    setPendingAction, getPendingAction, clearPendingAction,
    createSession, reopenSession, endSession, getSessionsByChat, getSessionById,
    findOrCreateMembers, addTransaction, getTransactions, deleteTransaction,
    calculateSettlement
};